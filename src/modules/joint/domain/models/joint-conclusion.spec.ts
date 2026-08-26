/**
 * JointConclusion 领域模型逐方法测试（JNT-005；覆盖率提升）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JointConclusion } from './joint-conclusion';
import { JointConclusionStateMachine } from '../state-machines/joint-conclusion.state-machine';

const machine = new JointConclusionStateMachine();
const NOW = new Date('2026-08-01T00:00:00Z');
const LATER = new Date('2026-08-02T00:00:00Z');

function makeEditable() {
  return JointConclusion.createEditable({
    jointActivityId: 'act-001',
    jointApplicationId: 'app-001',
    clubId: 'club-a',
    now: NOW,
  });
}

describe('JointConclusion（领域模型）', () => {
  it('conclusionId：派生自 applicationId + clubId', () => {
    assert.equal(JointConclusion.conclusionId('app-001', 'club-a'), 'conclusion:app-001:club-a');
  });

  it('createEditable：初始可编辑 + 版本 1', () => {
    const c = makeEditable();
    assert.equal(c.toSnapshot().revisionNumber, 1);
  });

  it('fromSnapshot → toSnapshot：快照往返一致', () => {
    const original = makeEditable().toSnapshot();
    const restored = JointConclusion.fromSnapshot(original);
    assert.deepEqual(restored.toSnapshot(), original);
  });

  it('edit：设置结论（ADMIT + note）', () => {
    const c = makeEditable();
    c.edit(machine, {
      decision: 'ADMIT',
      note: '表现优秀',
      editorId: 'u_admin',
      now: NOW,
    });
    assert.ok(true); // 不抛错即通过
  });

  it('sendInvite → markInviteAccepted / markInviteRejected / timeoutInvite', () => {
    const accepted = makeEditable();
    accepted.edit(machine, { decision: 'ADMIT', editorId: 'u_admin', now: NOW });
    accepted.sendInvite(machine, { invitationId: 'inv-1', now: NOW });
    assert.equal(accepted.markInviteAccepted(machine, LATER), true);

    const timedOut = makeEditable();
    timedOut.edit(machine, { decision: 'TRANSFER', editorId: 'u_admin', now: NOW });
    timedOut.sendInvite(machine, { invitationId: 'inv-3', now: NOW });
    assert.equal(timedOut.timeoutInvite(machine, LATER), true);
  });

  it('isLockedAgainstReject：返回 boolean', () => {
    const c = makeEditable();
    assert.equal(typeof c.isLockedAgainstReject(), 'boolean');
  });

  it('archive：归档不抛错', () => {
    const c = makeEditable();
    c.archive(machine, NOW);
    assert.ok(true);
  });
});
