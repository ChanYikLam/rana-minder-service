/**
 * 安全控制独立验证：SEC-CTL-033（通知恢复只补投渠道、不重放业务）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5（SEC-CTL-033）、
 * §14（站内信恢复严格承接 IFC-NTF-001）。
 *
 * 验证路径（真实纯状态机，无 pg/jose 依赖）：
 * - src/modules/notification/domain/state-machines/notification-state-machine.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NotificationStateMachine } from '../../src/modules/notification/domain/state-machines/notification-state-machine';

describe('SEC-CTL-033 通知投递与紧急关闭边界', () => {
  const machine = new NotificationStateMachine();

  it('SEC-CTL-033：待投递事实可推进站内信投递并落 DELIVERED', () => {
    const verdict = machine.evaluate({
      type: 'DELIVER_INBOX',
      currentStatus: 'CREATED_PENDING_DELIVERY',
    });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.newStatus, 'DELIVERED');
    assert.equal(verdict.newPresentationStatus, 'UNREAD');
  });

  it('SEC-CTL-033：已投递事实重复补投幂等——不产生新呈现状态、不重放业务', () => {
    const verdict = machine.evaluate({ type: 'DELIVER_INBOX', currentStatus: 'DELIVERED' });
    assert.equal(verdict.allowed, true, '恢复场景允许按原事件时间幂等补投');
    assert.equal(verdict.newPresentationStatus, null, '不得对既有呈现重复创建');
    assert.equal(verdict.newChannelStatus, 'DELIVERED');
  });

  it('SEC-CTL-033：紧急关闭期间站内信投递被拒，保持暂停而非假成功', () => {
    const verdict = machine.evaluate({
      type: 'DELIVER_INBOX',
      currentStatus: 'CREATED_PAUSED_DELIVERY',
    });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason ?? '', /暂停/);
  });

  it('SEC-CTL-033：紧急关闭仅作用于站内信渠道，不影响邮件渠道重试', () => {
    const verdict = machine.evaluate({
      type: 'KILL_INBOX',
      currentStatus: 'CREATED_PENDING_DELIVERY',
      channel: 'EMAIL',
    });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason ?? '', /邮件渠道不受影响/);
  });
});
