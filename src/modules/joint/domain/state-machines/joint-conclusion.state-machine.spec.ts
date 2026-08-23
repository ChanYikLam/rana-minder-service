/**
 * 联合社团结论状态机测试（JNT-005；SRS-SM-JNT-005）。
 *
 * 覆盖：编辑→邀请→接受锁定主链路、邀请拒绝/超时回退待复核、待复核恢复邀请、
 * 面试作废（TO_REVIEW）既可从可编辑态进入，也可从带待处理邀请的邀请态进入、
 * 已接受锁定不可再被作废/拒绝回退。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  JointConclusionStateMachine,
  JointConclusionEvent,
  JointConclusionStatus,
} from './joint-conclusion.state-machine';

const machine = new JointConclusionStateMachine();

describe('JointConclusionStateMachine（SRS-SM-JNT-005）', () => {
  it('主链路：EDITABLE → INVITE_PENDING → LOCKED_ACCEPTED（接受锁定）', () => {
    const sent = machine.transition({
      event: JointConclusionEvent.SEND_INVITE,
      currentState: JointConclusionStatus.EDITABLE,
    });
    assert.equal(sent.allowed, true);
    assert.equal(sent.nextState, JointConclusionStatus.INVITE_PENDING);

    const accepted = machine.transition({
      event: JointConclusionEvent.ACCEPT_INVITE,
      currentState: JointConclusionStatus.INVITE_PENDING,
    });
    assert.equal(accepted.allowed, true);
    assert.equal(accepted.nextState, JointConclusionStatus.LOCKED_ACCEPTED);
  });

  it('邀请被拒：INVITE_PENDING → REVIEW_PENDING（立即可重新编辑）', () => {
    const result = machine.transition({
      event: JointConclusionEvent.REJECT_INVITE,
      currentState: JointConclusionStatus.INVITE_PENDING,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.nextState, JointConclusionStatus.REVIEW_PENDING);
  });

  it('邀请超时：INVITE_PENDING → REVIEW_PENDING（保留邀请标识供恢复沿用）', () => {
    const result = machine.transition({
      event: JointConclusionEvent.TIMEOUT_INVITE,
      currentState: JointConclusionStatus.INVITE_PENDING,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.nextState, JointConclusionStatus.REVIEW_PENDING);
  });

  it('待复核恢复邀请：REVIEW_PENDING → INVITE_PENDING', () => {
    const result = machine.transition({
      event: JointConclusionEvent.RESTORE_FROM_REVIEW,
      currentState: JointConclusionStatus.REVIEW_PENDING,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.nextState, JointConclusionStatus.INVITE_PENDING);
  });

  it('面试作废：EDITABLE → REVIEW_PENDING', () => {
    const result = machine.transition({
      event: JointConclusionEvent.TO_REVIEW,
      currentState: JointConclusionStatus.EDITABLE,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.nextState, JointConclusionStatus.REVIEW_PENDING);
  });

  it('面试作废联动：INVITE_PENDING → REVIEW_PENDING（带待处理邀请的结论亦须进入待复核）', () => {
    const result = machine.transition({
      event: JointConclusionEvent.TO_REVIEW,
      currentState: JointConclusionStatus.INVITE_PENDING,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.nextState, JointConclusionStatus.REVIEW_PENDING);
  });

  it('已接受锁定后不可被作废或拒绝回退', () => {
    const toReview = machine.transition({
      event: JointConclusionEvent.TO_REVIEW,
      currentState: JointConclusionStatus.LOCKED_ACCEPTED,
    });
    assert.equal(toReview.allowed, false);

    const reject = machine.transition({
      event: JointConclusionEvent.REJECT_INVITE,
      currentState: JointConclusionStatus.LOCKED_ACCEPTED,
    });
    assert.equal(reject.allowed, false);
  });

  it('任意状态可归档为终态锁定', () => {
    for (const state of [
      JointConclusionStatus.EDITABLE,
      JointConclusionStatus.REVIEW_PENDING,
      JointConclusionStatus.INVITE_PENDING,
      JointConclusionStatus.LOCKED_ACCEPTED,
    ]) {
      const result = machine.transition({
        event: JointConclusionEvent.ARCHIVE,
        currentState: state,
      });
      assert.equal(result.allowed, true);
      assert.equal(result.nextState, JointConclusionStatus.ARCHIVED_LOCKED);
    }
  });
});
