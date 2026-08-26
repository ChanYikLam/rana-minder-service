/**
 * JointInterview 领域模型逐方法测试（JNT-004；覆盖率提升）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JointInterview } from './joint-interview';
import { JointInterviewStateMachine } from '../state-machines/joint-interview.state-machine';

const machine = new JointInterviewStateMachine();
const NOW = new Date('2026-08-01T00:00:00Z');
const LATER = new Date('2026-08-02T00:00:00Z');

function makePending() {
  return JointInterview.createPending({
    id: 'int-001',
    jointActivityId: 'act-001',
    jointApplicationId: 'app-001',
    now: NOW,
  });
}

describe('JointInterview（领域模型）', () => {
  it('createPending：初始 PENDING_CHOICE', () => {
    const i = makePending();
    const snap = i.toSnapshot();
    assert.equal(snap.status, 'PENDING_CHOICE');
    assert.equal(snap.revisionNumber, 1);
  });

  it('fromSnapshot → toSnapshot：快照往返一致', () => {
    const original = makePending().toSnapshot();
    const restored = JointInterview.fromSnapshot(original);
    assert.deepEqual(restored.toSnapshot(), original);
  });

  it('schedule → start → complete 主链', () => {
    const i = makePending();
    i.schedule(machine, { scheduledAt: LATER, location: '线上', method: 'ONLINE', now: NOW });
    assert.equal(i.toSnapshot().status, 'SCHEDULED');
    i.start(machine, NOW);
    assert.equal(i.toSnapshot().status, 'IN_PROGRESS');
    i.complete(machine, NOW);
    assert.equal(i.toSnapshot().status, 'COMPLETED');
  });

  it('void + reschedule：作废后重排回 SCHEDULED', () => {
    const i = makePending();
    i.schedule(machine, { scheduledAt: LATER, location: 'A101', method: 'ONSITE', now: NOW });
    i.voidInterview(machine, '面试官临时缺席', NOW);
    assert.equal(i.toSnapshot().status, 'VOIDED');
    i.reschedule(machine, {
      scheduledAt: new Date('2026-08-05'),
      location: 'B202',
      method: 'ONSITE',
      now: LATER,
    });
    assert.equal(i.toSnapshot().status, 'SCHEDULED');
  });
});
