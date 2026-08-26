/**
 * 安全控制独立验证：SEC-CTL-037（状态机每条命令继承安全控制；非法跃迁拒绝）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5（SEC-CTL-037）、
 * §22（SEC-TRC-SM-*）；SRS-SM-IDN-001/003、任务状态机明细。
 *
 * 验证路径（真实纯状态机，无 pg/jose 依赖）：
 * - src/modules/identity/domain/state-machines/name-correction.state-machine.ts
 * - src/modules/identity/domain/state-machines/account-access.state-machine.ts
 * - src/platform/tasks/scheduler/task-state-machine.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DefaultNameCorrectionStateMachine,
  NameCorrectionEvent,
  NameCorrectionState,
} from '../../src/modules/identity/domain/state-machines/name-correction.state-machine';
import {
  AccountAccessEvent,
  AccountAccessState,
  DefaultAccountAccessStateMachine,
} from '../../src/modules/identity/domain/state-machines/account-access.state-machine';
import { canTransition, isClaimable } from '../../src/platform/tasks/scheduler/task-state-machine';
import { TaskStatus } from '../../src/platform/tasks/contracts';

describe('SEC-CTL-037 姓名更正状态机：终态不再接受任何裁决', () => {
  const machine = new DefaultNameCorrectionStateMachine();

  it('SEC-CTL-037：SUBMITTED 可批准/驳回一次', () => {
    const approved = machine.transition({
      event: NameCorrectionEvent.APPROVE,
      currentState: NameCorrectionState.SUBMITTED,
    });
    assert.deepEqual(approved, {
      allowed: true,
      nextState: NameCorrectionState.APPROVED,
      reason: null,
    });

    const rejected = machine.transition({
      event: NameCorrectionEvent.REJECT,
      currentState: NameCorrectionState.SUBMITTED,
    });
    assert.equal(rejected.allowed, true);
    assert.equal(rejected.nextState, NameCorrectionState.REJECTED);
  });

  it('SEC-CTL-037：已批准申请再裁决（批准或驳回）均拒绝——审批只一次', () => {
    for (const event of [NameCorrectionEvent.APPROVE, NameCorrectionEvent.REJECT]) {
      const verdict = machine.transition({
        event,
        currentState: NameCorrectionState.APPROVED,
      });
      assert.equal(verdict.allowed, false, `APPROVED × ${event}`);
      assert.equal(verdict.nextState, NameCorrectionState.APPROVED);
      assert.match(verdict.reason ?? '', /终态/);
    }
  });

  it('SEC-CTL-037：已驳回申请再裁决拒绝；未知事件拒绝', () => {
    const verdict = machine.transition({
      event: NameCorrectionEvent.APPROVE,
      currentState: NameCorrectionState.REJECTED,
    });
    assert.equal(verdict.allowed, false);

    const unknown = machine.transition({
      event: 'HACK' as NameCorrectionEvent,
      currentState: NameCorrectionState.SUBMITTED,
    });
    assert.equal(unknown.allowed, false);
  });
});

describe('SEC-CTL-037 账号访问状态机：删除优先与降级收口守卫', () => {
  const machine = new DefaultAccountAccessStateMachine();

  it('SEC-CTL-037：删除后收到禁用事件被拒（不得猜测禁用）', () => {
    const verdict = machine.transition({
      event: AccountAccessEvent.CASDOOR_DISABLED,
      currentState: AccountAccessState.DELETED,
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.nextState, AccountAccessState.DELETED);
    assert.match(verdict.reason ?? '', /删除/);
  });

  it('SEC-CTL-037：降级中禁用事件不直接生效，必须以可信回读收口', () => {
    const verdict = machine.transition({
      event: AccountAccessEvent.CASDOOR_DISABLED,
      currentState: AccountAccessState.UNVERIFIABLE,
    });
    assert.equal(verdict.allowed, false);

    const recovered = machine.transition({
      event: AccountAccessEvent.READBACK_RECOVERED,
      currentState: AccountAccessState.UNVERIFIABLE,
      readbackState: AccountAccessState.DISABLED,
    });
    assert.equal(recovered.allowed, true);
    assert.equal(recovered.sessionRevoke, true, '回读为禁用须立即终止会话');
  });

  it('SEC-CTL-037：回读结果不可用时不返回假恢复', () => {
    const verdict = machine.transition({
      event: AccountAccessEvent.READBACK_RECOVERED,
      currentState: AccountAccessState.UNVERIFIABLE,
      readbackState: 'GARBAGE' as AccountAccessState,
    });
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason ?? '', /假恢复|不可用/);
  });

  it('SEC-CTL-037：非禁用状态的恢复请求被拒（已删除账号不得经 REENABLED 复活）', () => {
    for (const state of [
      AccountAccessState.ACTIVE,
      AccountAccessState.DELETED,
      AccountAccessState.UNVERIFIABLE,
    ]) {
      const verdict = machine.transition({
        event: AccountAccessEvent.ACCOUNT_REENABLED,
        currentState: state,
      });
      assert.equal(verdict.allowed, false, state);
    }
  });
});

describe('SEC-CTL-037 任务状态机转换表守卫', () => {
  it('SEC-CTL-037：仅租约持有者路径可完成；PENDING 直跳 COMPLETED 非法', () => {
    assert.equal(canTransition(TaskStatus.PENDING, TaskStatus.LEASED), true);
    assert.equal(canTransition(TaskStatus.LEASED, TaskStatus.COMPLETED), true);
    assert.equal(canTransition(TaskStatus.PENDING, TaskStatus.COMPLETED), false);
    assert.equal(canTransition(TaskStatus.MANUAL_INTERVENTION, TaskStatus.LEASED), false);
    assert.equal(canTransition(TaskStatus.COMPLETED, TaskStatus.PENDING), false);
  });

  it('SEC-CTL-037：可领取状态仅限 PENDING/RETRYABLE_FAILED/UNCERTAIN', () => {
    assert.equal(isClaimable(TaskStatus.PENDING), true);
    assert.equal(isClaimable(TaskStatus.RETRYABLE_FAILED), true);
    assert.equal(isClaimable(TaskStatus.UNCERTAIN), true);
    assert.equal(isClaimable(TaskStatus.COMPLETED), false);
    assert.equal(isClaimable(TaskStatus.LEASED), false);
    assert.equal(isClaimable(TaskStatus.MANUAL_INTERVENTION), false);
  });
});
