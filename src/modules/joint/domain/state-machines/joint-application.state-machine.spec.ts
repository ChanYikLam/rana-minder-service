/**
 * 联合申请状态机逐转换测试（JNT-003；SRS-SM-JNT-003；P3 补测）。
 *
 * 主链：草拟 → 已提交 → 活动终局归档（只读）；ARCHIVED 为唯一终态。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  JointApplicationEvent,
  JointApplicationStateMachine,
  JointApplicationStatus,
} from './joint-application.state-machine';

const machine = new JointApplicationStateMachine();

function run(event: JointApplicationEvent, state: JointApplicationStatus) {
  return machine.transition({ event, currentState: state });
}

describe('JointApplicationStateMachine（JNT-003）', () => {
  it('SUBMIT：仅 DRAFT → SUBMITTED', () => {
    assert.deepEqual(run(JointApplicationEvent.SUBMIT, JointApplicationStatus.DRAFT), {
      allowed: true,
      nextState: JointApplicationStatus.SUBMITTED,
    });
    for (const s of [JointApplicationStatus.SUBMITTED, JointApplicationStatus.ARCHIVED]) {
      assert.equal(run(JointApplicationEvent.SUBMIT, s).allowed, false, `${s} 不可重复提交`);
    }
  });

  it('ARCHIVE：仅 SUBMITTED → ARCHIVED（活动终局归档）', () => {
    assert.deepEqual(run(JointApplicationEvent.ARCHIVE, JointApplicationStatus.SUBMITTED), {
      allowed: true,
      nextState: JointApplicationStatus.ARCHIVED,
    });
    for (const s of [JointApplicationStatus.DRAFT, JointApplicationStatus.ARCHIVED]) {
      assert.equal(run(JointApplicationEvent.ARCHIVE, s).allowed, false, `${s} 不可归档`);
    }
  });

  it('终态冻结：ARCHIVED 下所有事件拒绝', () => {
    for (const ev of Object.values(JointApplicationEvent)) {
      assert.equal(run(ev, JointApplicationStatus.ARCHIVED).allowed, false);
    }
  });
});
