import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decideWebhookHandling, WEBHOOK_DEFAULT_ENABLED } from './webhook-policy';

describe('Casdoor Webhook 策略', () => {
  it('默认关闭', () => {
    assert.equal(WEBHOOK_DEFAULT_ENABLED, false);
  });

  it('关闭时拒绝并说明不改变业务状态', () => {
    const decision = decideWebhookHandling({
      enabled: false,
      staticSecretConfigured: true,
      secretHeaderMatches: true,
      rateLimitAvailable: true,
      dedupSeen: false,
      receivedAt: '2026-08-20T00:00:00.000Z',
      localEventId: 'evt-1',
      objectType: 'USER',
      objectRef: 'u1',
      rawBodyDigest: 'digest',
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.envelope, null);
  });

  it('启用但秘密不匹配 → 拒绝，不触发读回', () => {
    const decision = decideWebhookHandling({
      enabled: true,
      staticSecretConfigured: true,
      secretHeaderMatches: false,
      rateLimitAvailable: true,
      dedupSeen: false,
      receivedAt: '2026-08-20T00:00:00.000Z',
      localEventId: 'evt-2',
      objectType: 'GROUP',
      objectRef: 'o/g',
      rawBodyDigest: 'digest',
    });
    assert.equal(decision.allowed, false);
  });

  it('启用且保护齐全 → 仅作为刷新提示', () => {
    const decision = decideWebhookHandling({
      enabled: true,
      staticSecretConfigured: true,
      secretHeaderMatches: true,
      rateLimitAvailable: true,
      dedupSeen: false,
      receivedAt: '2026-08-20T00:00:00.000Z',
      localEventId: 'evt-3',
      objectType: 'GROUP',
      objectRef: 'o/g',
      rawBodyDigest: 'digest',
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.envelope?.reason, 'refresh-hint');
  });
});
