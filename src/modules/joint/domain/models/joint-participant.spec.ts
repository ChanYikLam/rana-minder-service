/**
 * JointParticipant 领域模型逐方法测试（JNT-002；覆盖率提升）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JointParticipant } from './joint-participant';
import { JointParticipantStateMachine } from '../state-machines/joint-participant.state-machine';

const machine = new JointParticipantStateMachine();
const NOW = new Date('2026-08-01T00:00:00Z');
const LATER = new Date('2026-08-02T00:00:00Z');

function makeProposed() {
  return JointParticipant.createProposed({
    activityId: 'act-001',
    clubId: 'club-a',
    roundId: 1,
    now: NOW,
  });
}

describe('JointParticipant（领域模型）', () => {
  it('participantId：派生自 activityId + clubId', () => {
    assert.equal(JointParticipant.participantId('act-001', 'club-a'), 'participant:act-001:club-a');
  });

  it('createProposed：初始 PROPOSED', () => {
    const p = makeProposed();
    assert.equal(p.toSnapshot().status, 'PROPOSED');
    assert.equal(p.toSnapshot().revisionNumber, 1);
  });

  it('fromSnapshot → toSnapshot：快照往返一致', () => {
    const original = makeProposed().toSnapshot();
    const restored = JointParticipant.fromSnapshot(original);
    assert.deepEqual(restored.toSnapshot(), original);
  });

  it('confirm：轮次匹配 → CONFIRMED', () => {
    const p = makeProposed();
    p.confirm(machine, 1, 'u_admin', NOW);
    assert.equal(p.toSnapshot().status, 'CONFIRMED');
    assert.equal(p.toSnapshot().decidedBy, 'u_admin');
  });

  it('participate：CONFIRMED → PARTICIPATING', () => {
    const p = makeProposed();
    p.confirm(machine, 1, 'u_admin', NOW);
    p.participate(machine, LATER);
    assert.equal(p.toSnapshot().status, 'PARTICIPATING');
  });

  it('withdraw：PROPOSED → WITHDRAWN；repropose 回 PROPOSED', () => {
    const p = makeProposed();
    p.withdraw(machine, NOW);
    assert.equal(p.toSnapshot().status, 'WITHDRAWN');
    p.repropose(machine, LATER);
    assert.equal(p.toSnapshot().status, 'PROPOSED');
  });
});
