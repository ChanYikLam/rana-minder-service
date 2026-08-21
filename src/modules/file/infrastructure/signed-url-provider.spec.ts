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
});
