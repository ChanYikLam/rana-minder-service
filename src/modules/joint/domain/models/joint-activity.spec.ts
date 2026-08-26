/**
 * JointActivity 领域模型逐方法测试（P1 工作包⑤ 覆盖率提升；JNT-001）。
 *
 * 覆盖：createDraft 工厂校验、fromSnapshot/toSnapshot 往返、
 * isTerminal/assertNotTerminal、confirmAll/publish/markFirstInvitation/
 * cancelAll/beginEndConfirm/end/forceEnd 状态推进、bumpConfirmRound。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JointActivity } from './joint-activity';
import {
  JointActivityStateMachine,
  JointActivityStatus,
} from '../state-machines/joint-activity.state-machine';

const machine = new JointActivityStateMachine();
const NOW = new Date('2026-08-01T00:00:00Z');
const LATER = new Date('2026-09-01T00:00:00Z');

function makeDraft() {
  return JointActivity.createDraft({
    id: 'act-test',
    title: '联合迎新',
    description: null,
    confirmDeadline: LATER,
    createdBy: 'u_admin',
    now: NOW,
  });
}

describe('JointActivity（领域模型）', () => {
  it('createDraft：初始 DRAFT_CONFIRMING + 参与者空 + 通道关闭', () => {
    const a = makeDraft();
    const snap = a.toSnapshot();
    assert.equal(snap.status, JointActivityStatus.DRAFT_CONFIRMING);
    assert.equal(snap.confirmRound, 1);
    assert.equal(snap.revisionNumber, 1);
    assert.ok(snap.id);
  });

  it('fromSnapshot → toSnapshot：快照往返一致', () => {
    const original = makeDraft().toSnapshot();
    const restored = JointActivity.fromSnapshot(original);
    assert.deepEqual(restored.toSnapshot(), original);
  });

  it('isTerminal：ENDED/CANCELLED/FORCE_ENDED 为终态', () => {
    assert.equal(makeDraft().isTerminal(), false);
    const ended = JointActivity.fromSnapshot({
      ...makeDraft().toSnapshot(),
      status: JointActivityStatus.ENDED,
    });
    assert.equal(ended.isTerminal(), true);
  });

  it('confirmAll：DRAFT_CONFIRMING → ESTABLISHED', () => {
    const a = makeDraft();
    assert.equal(a.confirmAll(machine, NOW), true);
    assert.equal(a.toSnapshot().status, JointActivityStatus.ESTABLISHED);
  });

  it('publish：ESTABLISHED → PUBLISHED', () => {
    const a = makeDraft();
    a.confirmAll(machine, NOW);
    assert.equal(a.publish(machine, NOW), true);
    assert.equal(a.toSnapshot().status, JointActivityStatus.PUBLISHED);
  });

  it('cancelAll：DRAFT_CONFIRMING → CANCELLED（终态）', () => {
    const a = makeDraft();
    assert.equal(a.cancelAll(machine, NOW), true);
    assert.equal(a.toSnapshot().status, JointActivityStatus.CANCELLED);
    assert.throws(() => a.assertNotTerminal(), /终态/);
  });

  it('forceEnd：任意非终态 → FORCE_ENDED 并记录原因', () => {
    const a = makeDraft();
    a.forceEnd(machine, '紧急停用', NOW);
    const snap = a.toSnapshot();
    assert.equal(snap.status, JointActivityStatus.FORCE_ENDED);
    assert.equal(snap.forcedEndedReason, '紧急停用');
  });

  it('bumpConfirmRound：轮次+1 且截止时间更新', () => {
    const a = makeDraft();
    const before = a.toSnapshot().confirmRound;
    a.bumpConfirmRound(NOW, new Date('2026-10-01'));
    assert.equal(a.toSnapshot().confirmRound, before + 1);
  });

  it('markFirstInvitation：并发单胜者幂等（PUBLISHED → INVITING）', () => {
    const a = makeDraft();
    a.confirmAll(machine, NOW);
    a.publish(machine, NOW);
    // 首次调用成功
    assert.equal(a.markFirstInvitation(machine, NOW), true);
    assert.equal(a.toSnapshot().status, JointActivityStatus.INVITING);
    assert.ok(a.toSnapshot().firstInvitationAt);
    // 幂等：并发只有一份胜出，重复调用返回 false 且不改状态
    assert.equal(a.markFirstInvitation(machine, LATER), false);
    assert.equal(a.toSnapshot().status, JointActivityStatus.INVITING);
    // 首邀后名单永久锁定：禁止 bumpConfirmRound 调整名单
    assert.throws(
      () => a.bumpConfirmRound(LATER, new Date('2026-10-01')),
      (err: unknown) =>
        err instanceof Error &&
        'code' in err &&
        (err as { code: string }).code === 'JNT_ACT_LOCKED',
    );
  });

  it('beginEndConfirm → end：INVITING → END_CONFIRMING → ENDED 主链', () => {
    const a = makeDraft();
    a.confirmAll(machine, NOW);
    a.publish(machine, NOW);
    a.markFirstInvitation(machine, NOW);
    assert.equal(a.beginEndConfirm(machine, NOW), true);
    assert.equal(a.toSnapshot().status, JointActivityStatus.END_CONFIRMING);
    assert.equal(a.end(machine, LATER), true);
    assert.equal(a.toSnapshot().status, JointActivityStatus.ENDED);
    // ENDED 为终态，普通业务写命令被拒绝
    assert.throws(() => a.assertNotTerminal(), /终态/);
  });
});
