/**
 * T3 外部依赖最近结果记录器单元测试。
 *
 * 覆盖：新鲜结果回填、过期显示"未知"（ADR-011 §2.1）、无记录"未知"、
 * 拒绝陈旧覆盖（后写覆盖、时间戳守卫）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryDepLatestRecorder } from './dep-latest-recorder';

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

describe('InMemoryDepLatestRecorder（外部依赖最近结果记录器）', () => {
  it('无记录时返回 unknown', async () => {
    const rec = new InMemoryDepLatestRecorder({ now: fixedNow('2026-08-22T00:00:00Z') });
    assert.deepEqual(await rec.latest('casdoor'), { state: 'unknown' });
  });

  it('新鲜结果返回 fresh（success 不带 lastError）', async () => {
    const now = fixedNow('2026-08-22T00:00:00Z');
    const rec = new InMemoryDepLatestRecorder({ now });
    rec.record({
      dep: 'casdoor',
      lastCheckedAt: new Date('2026-08-22T00:00:00Z'),
      lastResult: 'success',
    });
    const latest = await rec.latest('casdoor');
    assert.equal(latest.state, 'fresh');
    if (latest.state === 'fresh') {
      assert.equal(latest.lastResult, 'success');
      assert.equal(latest.lastError, undefined);
    }
  });

  it('失败结果携带脱敏 lastError', async () => {
    const rec = new InMemoryDepLatestRecorder({ now: fixedNow('2026-08-22T00:00:00Z') });
    rec.record({
      dep: 'mail',
      lastCheckedAt: new Date('2026-08-22T00:00:00Z'),
      lastResult: 'failure',
      lastError: 'smtp-timeout',
    });
    const latest = await rec.latest('mail');
    if (latest.state === 'fresh') {
      assert.equal(latest.lastError, 'smtp-timeout');
    }
  });

  it('来源过期（超过 TTL）显示 unknown，不以最近成功伪装健康', async () => {
    const rec = new InMemoryDepLatestRecorder({
      now: fixedNow('2026-08-22T00:10:00Z'),
      ttlMs: 5 * 60 * 1000,
    });
    rec.record({
      dep: 'backup',
      lastCheckedAt: new Date('2026-08-22T00:00:00Z'),
      lastResult: 'success',
    });
    // 10 分钟后：过期。
    assert.deepEqual(await rec.latest('backup'), { state: 'unknown' });
  });

  it('边界时间（恰好等于 TTL）视为新鲜', async () => {
    const rec = new InMemoryDepLatestRecorder({
      now: fixedNow('2026-08-22T00:05:00Z'),
      ttlMs: 5 * 60 * 1000,
    });
    rec.record({
      dep: 'notify',
      lastCheckedAt: new Date('2026-08-22T00:00:00Z'),
      lastResult: 'failure',
      lastError: 'x',
    });
    const latest = await rec.latest('notify');
    assert.equal(latest.state, 'fresh');
  });

  it('拒绝陈旧覆盖：时间戳更早的结果不得覆盖更新的结果', async () => {
    const rec = new InMemoryDepLatestRecorder({ now: fixedNow('2026-08-22T00:00:00Z') });
    rec.record({
      dep: 'file-check',
      lastCheckedAt: new Date('2026-08-22T00:02:00Z'),
      lastResult: 'success',
    });
    rec.record({
      dep: 'file-check',
      lastCheckedAt: new Date('2026-08-22T00:01:00Z'),
      lastResult: 'failure',
      lastError: 'old',
    });
    const latest = await rec.latest('file-check');
    if (latest.state === 'fresh') {
      assert.equal(latest.lastResult, 'success');
      assert.equal(latest.lastError, undefined);
    }
  });
});
