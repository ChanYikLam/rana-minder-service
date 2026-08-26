/**
 * JointConclusion 领域模型逐方法测试（JNT-005；覆盖率提升）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JointConclusion } from './joint-conclusion';
import {
  JointConclusionStateMachine,
  JointConclusionStatus,
} from '../state-machines/joint-conclusion.state-machine';

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

  it('edit：设置结论（ADMIT + note）并追加审计留痕', () => {
    const c = makeEditable();
    c.edit(machine, {
      decision: 'ADMIT',
      note: '表现优秀',
      editorId: 'u_admin',
      now: NOW,
    });
    const snap = c.toSnapshot();
    // 决策、版本与审计留痕真实写入（append-only）
    assert.equal(snap.decision, 'ADMIT');
    assert.equal(snap.note, '表现优秀');
    assert.equal(snap.version, 2);
    assert.equal(snap.decidedBy, 'u_admin');
    assert.equal(snap.versions.length, 1);
    assert.deepEqual(snap.versions[0], {
      decision: 'ADMIT',
      note: '表现优秀',
      editorId: 'u_admin',
      at: NOW,
    });
    // 再次编辑 → 留痕追加而非覆盖
    c.edit(machine, {
      decision: 'TRANSFER',
      note: '复核后改判',
      editorId: 'u_admin',
      now: LATER,
    });
    const snap2 = c.toSnapshot();
    assert.equal(snap2.decision, 'TRANSFER');
    assert.equal(snap2.version, 3);
    assert.equal(snap2.versions.length, 2);
    assert.equal(snap2.versions[0].decision, 'ADMIT');
    assert.equal(snap2.versions[1].decision, 'TRANSFER');
  });

  it('sendInvite → markInviteAccepted / markInviteRejected / timeoutInvite', () => {
    // 接受 → LOCKED_ACCEPTED，不可再改
    const accepted = makeEditable();
    accepted.edit(machine, { decision: 'ADMIT', editorId: 'u_admin', now: NOW });
    accepted.sendInvite(machine, { invitationId: 'inv-1', now: NOW });
    assert.equal(accepted.markInviteAccepted(machine, LATER), true);
    assert.equal(accepted.status, JointConclusionStatus.LOCKED_ACCEPTED);

    // 拒绝 → 回退 REVIEW_PENDING，可重新编辑
    const rejected = makeEditable();
    rejected.edit(machine, { decision: 'REJECT', editorId: 'u_admin', now: NOW });
    rejected.sendInvite(machine, { invitationId: 'inv-2', now: NOW });
    assert.equal(rejected.markInviteRejected(machine, LATER), true);
    assert.equal(rejected.status, JointConclusionStatus.REVIEW_PENDING);

    // 超时 → 回退 REVIEW_PENDING
    const timedOut = makeEditable();
    timedOut.edit(machine, { decision: 'TRANSFER', editorId: 'u_admin', now: NOW });
    timedOut.sendInvite(machine, { invitationId: 'inv-3', now: NOW });
    assert.equal(timedOut.timeoutInvite(machine, LATER), true);
    assert.equal(timedOut.status, JointConclusionStatus.REVIEW_PENDING);
  });

  it('isLockedAgainstReject：邀请接受后锁定，不可改为不录取', () => {
    // 编辑态/邀请待处理 → 未锁定
    const before = makeEditable();
    assert.equal(before.isLockedAgainstReject(), false);

    // 发出邀请但未接受 → 仍未锁定
    const pending = makeEditable();
    pending.edit(machine, { decision: 'ADMIT', editorId: 'u_admin', now: NOW });
    pending.sendInvite(machine, { invitationId: 'inv-1', now: NOW });
    assert.equal(pending.isLockedAgainstReject(), false);

    // 邀请被接受 → 立即锁定，禁止改为不录取
    pending.markInviteAccepted(machine, LATER);
    assert.equal(pending.isLockedAgainstReject(), true);

    // 已接受锁定后禁止编辑
    assert.throws(
      () => pending.edit(machine, { decision: 'REJECT', editorId: 'u_admin', now: LATER }),
      (err: unknown) =>
        err instanceof Error &&
        'code' in err &&
        (err as { code: string }).code === 'JNT_CON_LOCKED',
    );
  });

  it('archive：归档推进到 ARCHIVED_LOCKED 终态', () => {
    const c = makeEditable();
    c.archive(machine, NOW);
    assert.equal(c.status, JointConclusionStatus.ARCHIVED_LOCKED);
    const snap = c.toSnapshot();
    assert.equal(snap.revisionNumber, 2);
    // 终态只读：归档后编辑被拒绝
    assert.throws(
      () => c.edit(machine, { decision: 'ADMIT', editorId: 'u_admin', now: LATER }),
      (err: unknown) =>
        err instanceof Error &&
        'code' in err &&
        (err as { code: string }).code === 'JNT_CON_LOCKED',
    );
  });
});
