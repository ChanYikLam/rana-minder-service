/**
 * 面试记录领域测试（REC-005）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InterviewRecord } from './interview-record';
import { DefaultInterviewRecordStateMachine } from '../state-machines/interview-record.state-machine';

const NOW = new Date('2026-08-21T13:00:00.000Z');
const MACHINE = new DefaultInterviewRecordStateMachine();

function pending() {
  return InterviewRecord.createPending({
    id: 'iv1',
    applicationId: 'app1',
    activityId: 'a1',
    clubId: 'c1',
    roundId: 'r1',
    applicantId: 'u1',
    now: NOW,
  });
}

describe('InterviewRecord (REC-005)', () => {
  it('待选择 → 已安排 → 进行中 → 已完成', () => {
    const iv = pending();
    assert.equal(iv.schedule(MACHINE, 'inter1', new Date(NOW), 'Room1', NOW), true);
    assert.equal(iv.status, 'SCHEDULED');
    assert.equal(iv.start(MACHINE, NOW), true);
    assert.equal(iv.status, 'IN_PROGRESS');
    assert.equal(iv.complete(MACHINE, NOW), true);
    assert.equal(iv.status, 'COMPLETED');
  });

  it('作废 → 重排（保留原始事实）', () => {
    const iv = pending();
    iv.schedule(MACHINE, 'inter1', new Date(NOW), 'Room1', NOW);
    iv.start(MACHINE, NOW);
    assert.equal(iv.void(MACHINE, NOW), true);
    assert.equal(iv.status, 'VOIDED');
    assert.equal(iv.reschedule(MACHINE, NOW), true);
    assert.equal(iv.status, 'SCHEDULED');
  });

  it('取消（待选择/已安排可取消）', () => {
    const iv = pending();
    assert.equal(iv.cancel(MACHINE, NOW), true);
    assert.equal(iv.status, 'CANCELLED');
  });

  it('跳轮/免试：SKIPPED 且记原因', () => {
    const iv = pending();
    assert.equal(iv.skip(MACHINE, '表现优异免试', NOW), true);
    assert.equal(iv.status, 'SKIPPED');
    assert.equal(iv.toSnapshot().skipReason, '表现优异免试');
  });

  it('已安排可跳轮/免试（REC-040：待选择或已安排）', () => {
    const iv = pending();
    assert.equal(iv.schedule(MACHINE, 'i1', NOW, null, NOW), true);
    assert.equal(iv.skip(MACHINE, '轮次冲突跳轮', NOW), true);
    assert.equal(iv.status, 'SKIPPED');
  });

  it('出勤事件：请假/迟到/缺席 → 重排回已安排（SRS-SM-REC-005）', () => {
    const leave = pending();
    leave.schedule(MACHINE, 'i1', NOW, null, NOW);
    assert.equal(leave.markOnLeave(MACHINE, NOW), true);
    assert.equal(leave.status, 'ON_LEAVE');
    assert.equal(leave.reschedule(MACHINE, NOW), true);
    assert.equal(leave.status, 'SCHEDULED');

    const absent = pending();
    absent.schedule(MACHINE, 'i1', NOW, null, NOW);
    assert.equal(absent.markAbsent(MACHINE, NOW), true);
    assert.equal(absent.status, 'ABSENT');
    assert.equal(absent.reschedule(MACHINE, NOW), true);
    assert.equal(absent.status, 'SCHEDULED');
  });

  it('迟到可开始面试（SRS-SM-REC-005：已安排或迟到 → 进行中）', () => {
    const iv = pending();
    iv.schedule(MACHINE, 'i1', NOW, null, NOW);
    assert.equal(iv.markLate(MACHINE, NOW), true);
    assert.equal(iv.status, 'LATE');
    assert.equal(iv.start(MACHINE, NOW), true);
    assert.equal(iv.status, 'IN_PROGRESS');
  });

  it('暂缓 → 恢复', () => {
    const iv = pending();
    assert.equal(iv.hold(MACHINE, new Date('2026-08-25T00:00:00.000Z'), NOW), true);
    assert.equal(iv.status, 'HOLD');
    assert.equal(iv.resume(NOW), true);
    assert.equal(iv.status, 'PENDING_SELECTION');
    // 恢复后应清除暂缓截止，避免残留旧期限（数据一致性）
    assert.equal(iv.toSnapshot().holdUntil, null);
  });

  it('记录评价（进行中可记录，终态不可）', () => {
    const iv = pending();
    iv.schedule(MACHINE, 'inter1', new Date(NOW), 'Room1', NOW);
    iv.start(MACHINE, NOW);
    iv.recordEvaluation('inter1', { score: 90 }, NOW);
    assert.equal(iv.toSnapshot().evaluations.length, 1);
    iv.complete(MACHINE, NOW);
    iv.recordEvaluation('inter1', { score: 95 }, NOW);
    assert.equal(iv.toSnapshot().evaluations.length, 2);
  });
});
