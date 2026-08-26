/**
 * 安全控制独立验证：SEC-CTL-026（Webhook 默认关闭且非权威）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5、§14；
 * CAS-EVT-001~007。
 *
 * 验证路径（真实纯函数，无 pg/jose 依赖）：
 * - src/platform/casdoor/domain/webhook-policy.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  WEBHOOK_DEFAULT_ENABLED,
  decideWebhookHandling,
  type WebhookDecisionInput,
} from '../../src/platform/casdoor/domain/webhook-policy';

const ENABLED_INPUT: WebhookDecisionInput = {
  enabled: true,
  staticSecretConfigured: true,
  secretHeaderMatches: true,
  rateLimitAvailable: true,
  dedupSeen: false,
  receivedAt: '2026-08-24T08:00:00Z',
  localEventId: 'evt-1',
  objectType: 'USER',
  objectRef: 'user-42',
  rawBodyDigest: 'digest-abc',
};

describe('SEC-CTL-026 Webhook 默认关闭且仅作非权威刷新提示', () => {
  it('SEC-CTL-026：默认开关常量为关闭', () => {
    assert.equal(WEBHOOK_DEFAULT_ENABLED, false);
  });

  it('SEC-CTL-026：未启用时一律拒绝且不产生事件信封（CAS-EVT-001）', () => {
    const verdict = decideWebhookHandling({ ...ENABLED_INPUT, enabled: false });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.envelope, null);
    assert.match(verdict.reason, /CAS-EVT-001/);
  });

  it('SEC-CTL-026：静态秘密未配置或不匹配拒绝（CAS-EVT-002）；缺限流保护拒绝', () => {
    const noSecret = decideWebhookHandling({
      ...ENABLED_INPUT,
      staticSecretConfigured: false,
      secretHeaderMatches: false,
    });
    assert.equal(noSecret.allowed, false);
    assert.match(noSecret.reason, /CAS-EVT-002/);

    const noRateLimit = decideWebhookHandling({ ...ENABLED_INPUT, rateLimitAvailable: false });
    assert.equal(noRateLimit.allowed, false);
    assert.match(noRateLimit.reason, /限流/);
  });

  it('SEC-CTL-026：重复事件去重拒绝（CAS-EVT-004），不重复触发刷新', () => {
    const verdict = decideWebhookHandling({ ...ENABLED_INPUT, dedupSeen: true });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason, /CAS-EVT-004/);
  });

  it('SEC-CTL-026：全条件满足也只产出"refresh-hint"非权威信封，不改业务事实', () => {
    const verdict = decideWebhookHandling(ENABLED_INPUT);
    assert.equal(verdict.allowed, true);
    assert.notEqual(verdict.envelope, null);
    assert.equal(verdict.envelope?.reason, 'refresh-hint');
    assert.match(verdict.reason, /非权威刷新提示/);
    assert.equal(verdict.envelope?.objectType, 'USER');
    assert.equal(verdict.envelope?.allowed, true);
  });
});
