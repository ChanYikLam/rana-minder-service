/**
 * 联合参与社团关系状态机测试（JNT-002；SRS-SM-JNT-002）。
 *
 * 覆盖：拟参与→确认→固化参与→紧急停用/恢复主链路、撤回、撤回后重新提出
 * （WITHDRAWN → PROPOSED）、确认轮次不匹配进入待重确认、公布后不可新增/退出。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  JointParticipantStateMachine,
  JointParticipantEvent,
  JointParticipantStatus,
} from './joint-participant.state-machine';

const machine = new JointParticipantStateMachine();

describe('JointParticipantStateMachine（SRS-SM-JNT-002）', () => {
  it('主链路：PROPOSED → CONFIRMED → PARTICIPATING', () => {
    const confirmed = machine.transition({
      event: JointParticipantEvent.CONFIRM,
      currentState: JointParticipantStatus.PROPOSED,
    });
    assert.equal(confirmed.allowed, true);
    assert.equal(confirmed.nextState, JointParticipantStatus.CONFIRMED);

    const participating = machine.transition({
      event: JointParticipantEvent.PARTICIPATE,
      currentState: JointParticipantStatus.CONFIRMED,
    });
    assert.equal(participating.allowed, true);
    assert.equal(participating.nextState, JointParticipantStatus.PARTICIPATING);
  });

  it('撤回：PROPOSED → WITHDRAWN；撤回后不可确认', () => {
    const withdrawn = machine.transition({
      event: JointParticipantEvent.WITHDRAW,
      currentState: JointParticipantStatus.PROPOSED,
    });
    assert.equal(withdrawn.allowed, true);
    assert.equal(withdrawn.nextState, JointParticipantStatus.WITHDRAWN);

    const confirmAfterWithdraw = machine.transition({
      event: JointParticipantEvent.CONFIRM,
      currentState: JointParticipantStatus.WITHDRAWN,
    });
    assert.equal(confirmAfterWithdraw.allowed, false);
  });

  it('撤回后重新提出：WITHDRAWN → PROPOSED（唯一聚合，不新建冲突行）', () => {
    const result = machine.transition({
      event: JointParticipantEvent.REPROPOSE,
      currentState: JointParticipantStatus.WITHDRAWN,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.nextState, JointParticipantStatus.PROPOSED);
  });

  it('确认轮次不匹配进入待重确认：CONFIRMED → STALE_RECONFIRM；重确认回 CONFIRMED', () => {
    const stale = machine.transition({
      event: JointParticipantEvent.STALE,
      currentState: JointParticipantStatus.CONFIRMED,
    });
    assert.equal(stale.allowed, true);
    assert.equal(stale.nextState, JointParticipantStatus.STALE_RECONFIRM);

    const reconfirm = machine.transition({
      event: JointParticipantEvent.RECONFIRM,
      currentState: JointParticipantStatus.STALE_RECONFIRM,
    });
    assert.equal(reconfirm.allowed, true);
    assert.equal(reconfirm.nextState, JointParticipantStatus.CONFIRMED);
  });

  it('紧急停用/恢复：PARTICIPATING → EMERGENCY_SUSPENDED → PARTICIPATING', () => {
    const suspended = machine.transition({
      event: JointParticipantEvent.SUSPEND,
      currentState: JointParticipantStatus.PARTICIPATING,
    });
    assert.equal(suspended.allowed, true);
    assert.equal(suspended.nextState, JointParticipantStatus.EMERGENCY_SUSPENDED);

    const resumed = machine.transition({
      event: JointParticipantEvent.RESUME,
      currentState: JointParticipantStatus.EMERGENCY_SUSPENDED,
    });
    assert.equal(resumed.allowed, true);
    assert.equal(resumed.nextState, JointParticipantStatus.PARTICIPATING);
  });

  it('公布后不可新增/退出/替换：仅可紧急停用/恢复（PARTICIPATING 不可撤回/确认）', () => {
    for (const event of [
      JointParticipantEvent.CONFIRM,
      JointParticipantEvent.WITHDRAW,
      JointParticipantEvent.PARTICIPATE,
    ]) {
      const result = machine.transition({
        event,
        currentState: JointParticipantStatus.PARTICIPATING,
      });
      assert.equal(result.allowed, false);
    }
  });
});
