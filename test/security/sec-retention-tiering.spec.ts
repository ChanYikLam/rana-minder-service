/**
 * 安全控制独立验证：SEC-CTL-038（日志分层保留期基线）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5、§18；
 * ADR-011 §2.1（普通 90 天＝30 在线＋60 归档；网络/安全 ≥6 个月）。
 *
 * 验证路径（真实纯规则，无 pg/jose 依赖）：
 * - src/platform/observability/domain/services/retention.rules.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RETENTION_POLICIES,
  isLogTier,
  resolveRetention,
} from '../../src/platform/observability/domain/services/retention.rules';

describe('SEC-CTL-038 日志保留期分层基线', () => {
  it('SEC-CTL-038：普通运行日志 30 天在线 + 60 天归档 = 90 天', () => {
    const policy = resolveRetention('normal');
    assert.equal(policy.onlineDays, 30);
    assert.equal(policy.archiveDays, 60);
    assert.equal(policy.totalDays, 90);
    assert.equal(
      DEFAULT_RETENTION_POLICIES.normal.onlineDays + DEFAULT_RETENTION_POLICIES.normal.archiveDays,
      DEFAULT_RETENTION_POLICIES.normal.totalDays,
    );
  });

  it('SEC-CTL-038：网络与安全事件日志不低于 6 个月且在线+归档自洽', () => {
    for (const tier of ['network', 'security'] as const) {
      const policy = resolveRetention(tier);
      assert.ok(policy.totalDays >= 180, `${tier} 总保留 ${policy.totalDays} 天`);
      assert.equal(policy.onlineDays + policy.archiveDays, policy.totalDays, tier);
    }
    assert.deepEqual(resolveRetention('security'), DEFAULT_RETENTION_POLICIES.security);
  });

  it('SEC-CTL-038：未知类别按 normal 兜底且 isLogTier 判别三类合法层级', () => {
    assert.deepEqual(resolveRetention('mystery-tier'), DEFAULT_RETENTION_POLICIES.normal);
    assert.equal(isLogTier('normal'), true);
    assert.equal(isLogTier('network'), true);
    assert.equal(isLogTier('security'), true);
    assert.equal(isLogTier('forever'), false);
  });
});
