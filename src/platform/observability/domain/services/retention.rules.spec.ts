/**
 * 日志保留期规则测试（ADR-011 §2.1）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_RETENTION_POLICIES, isLogTier, resolveRetention } from './retention.rules';

test('默认保留策略：普通 90 天、网络/安全 180 天', () => {
  assert.deepEqual(DEFAULT_RETENTION_POLICIES.normal, {
    onlineDays: 30,
    archiveDays: 60,
    totalDays: 90,
  });
  assert.deepEqual(DEFAULT_RETENTION_POLICIES.network, {
    onlineDays: 30,
    archiveDays: 150,
    totalDays: 180,
  });
  assert.deepEqual(DEFAULT_RETENTION_POLICIES.security, {
    onlineDays: 30,
    archiveDays: 150,
    totalDays: 180,
  });
});

test('resolveRetention：未知类别回退到 normal', () => {
  assert.equal(resolveRetention('unknown').totalDays, 90);
  assert.equal(resolveRetention('normal').totalDays, 90);
  assert.equal(resolveRetention('security').totalDays, 180);
});

test('isLogTier：只接受三类日志级别', () => {
  assert.equal(isLogTier('normal'), true);
  assert.equal(isLogTier('network'), true);
  assert.equal(isLogTier('security'), true);
  assert.equal(isLogTier('debug'), false);
});
