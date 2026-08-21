import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultSignedUrlProvider } from './signed-url-provider';
import { FileAccessAction } from '../domain/services/access-policy';

describe('DefaultSignedUrlProvider（IFC-FIL-005 短时地址：到期 + 一次性语义）', () => {
  const provider = new DefaultSignedUrlProvider();

  it('签发短时地址：令牌非空、到期在未来、含关联动作', async () => {
    const access = await provider.issue('f1', FileAccessAction.DOWNLOAD);
    assert.ok(access.token.length > 0);
    assert.ok(Date.parse(access.expiresAt) > Date.now());
    assert.equal(access.action, FileAccessAction.DOWNLOAD);
  });

  it('verify 一次性语义：首次消费通过，重复消费被拒（USED）', async () => {
    const access = await provider.issue('f1', FileAccessAction.PREVIEW, {
      watermarkContent: '查看者:u1',
    });
    const first = await provider.verify(access.token);
    assert.equal(first.valid, true);
    assert.equal(first.access?.token, access.token);
    // 一次性：再次消费应作废
    const second = await provider.verify(access.token);
    assert.equal(second.valid, false);
    assert.equal(second.reason, 'USED');
  });

  it('ttlMs 传入非有限值（NaN/±Infinity）→ 兜底为默认有效期，不抛 RangeError 崩溃', async () => {
    const access = await provider.issue('f1', FileAccessAction.DOWNLOAD, {
      ttlMs: NaN as unknown as number,
    });
    // 不崩溃且生成了有效期在未来的地址
    assert.ok(access.token.length > 0);
    assert.ok(Date.parse(access.expiresAt) > Date.now());
    const accessInf = await provider.issue('f1', FileAccessAction.DOWNLOAD, {
      ttlMs: Infinity,
    });
    assert.ok(Date.parse(accessInf.expiresAt) > Date.now());
  });

  it('ttlMs 超过上限 → 截断为最大有效期', async () => {
    const access = await provider.issue('f1', FileAccessAction.DOWNLOAD, {
      ttlMs: DefaultSignedUrlProvider.MAX_TTL_MS * 100,
    });
    const expiry = Date.parse(access.expiresAt) - Date.now();
    assert.ok(expiry <= DefaultSignedUrlProvider.MAX_TTL_MS);
  });

  it('verify 未知令牌 → 拒绝（UNKNOWN）', async () => {
    const result = await provider.verify('no-such-token');
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'UNKNOWN');
  });

  it('verify 到期令牌 → 拒绝（EXPIRED）', async () => {
    // 通过内部状态直接塞一个已过期令牌来验证到期逻辑
    const access = await provider.issue('f1', FileAccessAction.DOWNLOAD);
    const store = (
      provider as unknown as {
        store: Map<string, { expiresAt: number; consumed: boolean; access: unknown }>;
      }
    ).store;
    const state = store.get(access.token)!;
    store.set(access.token, { ...state, expiresAt: Date.now() - 1000 });
    const result = await provider.verify(access.token);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'EXPIRED');
  });

  it('issue 时清理已过期但从未被 verify 的残留令牌，避免内存不可收敛增长', async () => {
    // 用全新实例验证清理：确保首次 issue 即触发清理
    const fresh = new DefaultSignedUrlProvider();
    // 制造一个过期但从未被 verify 的令牌（模拟用户拿到短时地址但未点击）
    const stale = await fresh.issue('f1', FileAccessAction.DOWNLOAD, { ttlMs: 0 });
    const store = (
      fresh as unknown as {
        store: Map<string, { expiresAt: number; consumed: boolean; access: unknown }>;
      }
    ).store;
    // 手动将其置为已过期，且未消费
    const state = store.get(stale.token)!;
    store.set(stale.token, { ...state, expiresAt: Date.now() - 1000 });
    assert.ok(store.has(stale.token));
    // 将距上次清理的时间推进到超过间隔，确保再次签发时必然触发清理
    (fresh as unknown as { lastPrunedAt: number }).lastPrunedAt = Date.now() - 60_000;

    // 再次签发新令牌，应顺带清理过期的残留令牌
    await fresh.issue('f1', FileAccessAction.DOWNLOAD);
    assert.equal(store.has(stale.token), false, '过期且未被 verify 的残留令牌应在 issue 时被清理');
  });

  it('清理为节流/惰性：距上次清理不足间隔时不全量扫描（高频签发不 O(n) 遍历）', async () => {
    const fresh = new DefaultSignedUrlProvider();
    // 制造过期残留
    const stale = await fresh.issue('f1', FileAccessAction.DOWNLOAD, { ttlMs: 0 });
    const store = (
      fresh as unknown as {
        store: Map<string, { expiresAt: number; consumed: boolean; access: unknown }>;
        lastPrunedAt: number;
      }
    ).store;
    const state = store.get(stale.token)!;
    store.set(stale.token, { ...state, expiresAt: Date.now() - 1000 });
    // 模拟刚清理过（lastPrunedAt 设为当前），此时再次签发不应触发全量清理
    (fresh as unknown as { lastPrunedAt: number }).lastPrunedAt = Date.now();
    await fresh.issue('f1', FileAccessAction.DOWNLOAD);
    assert.ok(store.has(stale.token), '距上次清理不足间隔，不应执行全量清理（残留暂未被扫掉）');
    // 推进 lastPrunedAt 超过间隔后再次签发，应触发清理
    (fresh as unknown as { lastPrunedAt: number }).lastPrunedAt = Date.now() - 60_000;
    await fresh.issue('f1', FileAccessAction.DOWNLOAD);
    assert.equal(store.has(stale.token), false, '距上次清理超过间隔，应触发清理');
  });
});
