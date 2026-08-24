import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_RETENTION_POLICIES, resolveRetention, isLogTier } from './retention.rules';

describe('retention.rules', () => {
  it('普通日志：30 天在线 + 60 天归档 = 90 天', () => {
    const p = DEFAULT_RETENTION_POLICIES.normal;
    assert.equal(p.onlineDays, 30);
    assert.equal(p.archiveDays, 60);
    assert.equal(p.totalDays, 90);
  });

  it('网络日志：≥ 6 个月（180 天）', () => {
    const p = DEFAULT_RETENTION_POLICIES.network;
    assert.equal(p.totalDays, 180);
    assert.ok(p.totalDays >= 180);
  });

  it('安全日志：≥ 6 个月（180 天）', () => {
    const p = DEFAULT_RETENTION_POLICIES.security;
    assert.equal(p.totalDays, 180);
    assert.ok(p.totalDays >= 180);
  });

  it('resolveRetention：合法 tier 返回对应策略', () => {
    assert.equal(resolveRetention('normal').totalDays, 90);
    assert.equal(resolveRetention('network').totalDays, 180);
    assert.equal(resolveRetention('security').totalDays, 180);
  });

  it('resolveRetention：未知 tier 降级为 normal', () => {
    assert.equal(resolveRetention('mystery').totalDays, 90);
  });

  it('isLogTier：合法/非法分流', () => {
    assert.equal(isLogTier('normal'), true);
    assert.equal(isLogTier('security'), true);
    assert.equal(isLogTier('weird'), false);
    assert.equal(isLogTier(''), false);
  });
});
