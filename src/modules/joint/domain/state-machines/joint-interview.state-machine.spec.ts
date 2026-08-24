/**
 * 联合面试记录状态机逐转换测试（JNT-004；SRS-SM-JNT-004；P3 补测）。
 *
 * 主链：待选择 → 已安排 → 进行中 → 已完成 / 已作废（待重排→重新安排）；
 * 作废是唯一例外路径，不删除原始事实。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  JointInterviewEvent,
  JointInterviewStateMachine,
  JointInterviewStatus,
} from './joint-interview.state-machine';

const machine = new JointInterviewStateMachine();

function run(event: JointInterviewEvent, state: JointInterviewStatus) {
  return machine.transition({ event, currentState: state });
}

describe('JointInterviewStateMachine（JNT-004）', () => {
  it('主链四段全部允许且次态正确', () => {
    assert.deepEqual(run(JointInterviewEvent.SCHEDULE, JointInterviewStatus.PENDING_CHOICE), {
      allowed: true,
      nextState: JointInterviewStatus.SCHEDULED,
    });
    assert.deepEqual(run(JointInterviewEvent.START, JointInterviewStatus.SCHEDULED), {
      allowed: true,
      nextState: JointInterviewStatus.IN_PROGRESS,
    });
    assert.deepEqual(run(JointInterviewEvent.COMPLETE, JointInterviewStatus.IN_PROGRESS), {
      allowed: true,
      nextState: JointInterviewStatus.COMPLETED,
    });
  });

  it('作废门：SCHEDULED/IN_PROGRESS 可 VOID → VOIDED（待重排例外）', () => {
    for (const s of [JointInterviewStatus.SCHEDULED, JointInterviewStatus.IN_PROGRESS]) {
      const r = run(JointInterviewEvent.VOID, s);
      assert.equal(r.allowed, true, `${s} 应可作废`);
      assert.equal(r.nextState, JointInterviewStatus.VOIDED);
    }
    assert.equal(run(JointInterviewEvent.VOID, JointInterviewStatus.PENDING_CHOICE).allowed, false);
    assert.equal(run(JointInterviewEvent.VOID, JointInterviewStatus.COMPLETED).allowed, false);
  });

  it('重排：VOIDED → SCHEDULED（重新安排不删除原始事实）', () => {
    assert.deepEqual(run(JointInterviewEvent.RESCHEDULE, JointInterviewStatus.VOIDED), {
      allowed: true,
      nextState: JointInterviewStatus.SCHEDULED,
    });
    assert.equal(
      run(JointInterviewEvent.RESCHEDULE, JointInterviewStatus.SCHEDULED).allowed,
      false,
    );
  });

  it('错序拒绝：各事件仅在声明源状态被接受', () => {
    assert.equal(run(JointInterviewEvent.SCHEDULE, JointInterviewStatus.SCHEDULED).allowed, false);
    assert.equal(
      run(JointInterviewEvent.START, JointInterviewStatus.PENDING_CHOICE).allowed,
      false,
    );
    assert.equal(run(JointInterviewEvent.COMPLETE, JointInterviewStatus.SCHEDULED).allowed, false);
  });

  it('已完成冻结：COMPLETED 下全部事件拒绝', () => {
    for (const ev of Object.values(JointInterviewEvent)) {
      assert.equal(run(ev, JointInterviewStatus.COMPLETED).allowed, false);
    }
  });
});
