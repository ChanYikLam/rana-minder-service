/**
 * JointApplication 领域模型逐方法测试（JNT-003；覆盖率提升）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JointApplication } from './joint-application';
import {
  JointApplicationStateMachine,
  JointApplicationStatus,
} from '../state-machines/joint-application.state-machine';

const machine = new JointApplicationStateMachine();
const NOW = new Date('2026-08-01T00:00:00Z');

function makeDraft() {
  return JointApplication.createDraft({
    id: 'app-001',
    jointActivityId: 'act-001',
    applicantId: 'u_student',
    now: NOW,
  });
}

describe('JointApplication（领域模型）', () => {
  it('createDraft：初始 DRAFT + formRef null + consentHash null', () => {
    const a = makeDraft();
    const snap = a.toSnapshot();
    assert.equal(snap.status, JointApplicationStatus.DRAFT);
    assert.equal(snap.formRef, null);
    assert.equal(snap.consentSnapshotHash, null);
    assert.equal(snap.revisionNumber, 1);
  });

  it('fromSnapshot → toSnapshot：快照往返一致', () => {
    const original = makeDraft().toSnapshot();
    const restored = JointApplication.fromSnapshot(original);
    assert.deepEqual(restored.toSnapshot(), original);
  });

  it('submit：consentHash 匹配 → SUBMITTED + formRef 锁定', () => {
    const a = makeDraft();
    const hash = 'abc123';
    a.submit(machine, {
      formRef: { formId: 'f1', submissionId: 's1', versionNumber: 1 },
      participantsSnapshot: ['club-a', 'club-b'],
      consentSnapshotHash: hash,
      expectedConsentHash: hash,
      sharedNote: null,
      now: NOW,
    });
    assert.equal(a.toSnapshot().status, JointApplicationStatus.SUBMITTED);
    assert.ok(a.toSnapshot().formRef);
    assert.equal(a.toSnapshot().consentSnapshotHash, hash);
  });

  it('submit：consentHash 不匹配 → 拒绝（共享同意硬前提）', () => {
    const a = makeDraft();
    assert.throws(
      () =>
        a.submit(machine, {
          formRef: { formId: 'f1', submissionId: 's1', versionNumber: 1 },
          participantsSnapshot: ['club-a'],
          consentSnapshotHash: 'wrong-hash',
          expectedConsentHash: 'expected-hash',
          now: NOW,
        }),
      /共享同意|不匹配|consent/i,
    );
  });

  it('archive：SUBMITTED → ARCHIVED（终态冻结）', () => {
    const a = makeDraft();
    const hash = 'match';
    a.submit(machine, {
      formRef: { formId: 'f', submissionId: 's', versionNumber: 1 },
      participantsSnapshot: [],
      consentSnapshotHash: hash,
      expectedConsentHash: hash,
      now: NOW,
    });
    assert.equal(a.archive(machine, NOW), true);
    assert.equal(a.toSnapshot().status, JointApplicationStatus.ARCHIVED);
  });
});
