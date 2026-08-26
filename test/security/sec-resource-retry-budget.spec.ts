/**
 * 安全控制独立验证：SEC-CTL-035（任务重试预算封顶，资源保护代码侧证据）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5（SEC-CTL-035：
 * 可配置资源预算、超时、队列和并发保护；数值不是产品规则）。
 *
 * 验证路径（真实纯函数，无 pg/jose 依赖）：
 * - src/platform/tasks/retry-policy/retry-policy.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  canRetry,
  classifyFailure,
  computeExponentialBackoffMs,
  computeLinearBackoffMs,
  requiresManualIntervention,
} from '../../src/platform/tasks/retry-policy/retry-policy';

describe('SEC-CTL-035 重试预算封顶与退避上限', () => {
  it('SEC-CTL-035：canRetry 在达到上限后关闭（防无限重试耗尽资源）', () => {
    assert.equal(canRetry(0, 5), true);
    assert.equal(canRetry(4, 5), true);
    assert.equal(canRetry(5, 5), false);
    assert.equal(canRetry(6, 5), false);
    assert.equal(requiresManualIntervention(5, 5), true);
    assert.equal(requiresManualIntervention(4, 5), false);
  });

  it('SEC-CTL-035：指数退避封顶于 maxMs，超长 attempt 不再放大', () => {
    assert.equal(computeExponentialBackoffMs(0, 1000, 60_000), 1000);
    assert.equal(computeExponentialBackoffMs(3, 1000, 60_000), 8000);
    assert.equal(computeExponentialBackoffMs(30, 1000, 60_000), 60_000);
  });

  it('SEC-CTL-035：线性退避同样封顶；负数/非整数输入被安全规整', () => {
    assert.equal(computeLinearBackoffMs(3, 500, 2000), 1500);
    assert.equal(computeLinearBackoffMs(100, 500, 2000), 2000);
    assert.equal(computeLinearBackoffMs(-1, 500, 2000), 0);
    assert.equal(computeExponentialBackoffMs(1.9, 100, 10_000), 200);
  });

  it('SEC-CTL-035：失败分类可判别外部不确定与租约过期（不与普通失败混同）', () => {
    assert.equal(classifyFailure('upstream UNCERTAIN timeout'), 'EXTERNAL_UNCERTAIN');
    assert.equal(classifyFailure('LEASE expired before commit'), 'LEASE_EXPIRED');
    assert.equal(classifyFailure('PERMISSION denied for scope'), 'PERMISSION_DENIED');
    assert.equal(classifyFailure('VERSION stale on submit'), 'VERSION_STALE');
    assert.equal(classifyFailure('RETRY_LIMIT reached'), 'RETRY_LIMIT_EXCEEDED');
    assert.equal(classifyFailure('connection reset'), 'EXTERNAL_FAILED');
  });
});
