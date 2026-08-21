/**
 * FormSubmission 聚合 + 提交/修订状态机（FORM-002）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FormSubmission } from '../models/form-submission';
import {
  FormSubmissionState,
  FormSubmissionEvent,
  DefaultFormSubmissionStateMachine,
} from '../state-machines/form-submission.state-machine';

const NOW = new Date('2026-08-21T08:00:00.000Z');
const SCOPE = { kind: 'club', ownerId: 'club-1' } as const;
const VALUES = { name: '张三', age: 20 };

describe('FormSubmission 状态机（FORM-002）', () => {
  const machine = new DefaultFormSubmissionStateMachine();

  it('DRAFT + SUBMIT → SUBMITTED', () => {
    const r = machine.transition({
      event: FormSubmissionEvent.SUBMIT,
      currentState: FormSubmissionState.DRAFT,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, FormSubmissionState.SUBMITTED);
  });

  it('DRAFT + REVISE → 拒绝（未提交不能修订）', () => {
    const r = machine.transition({
      event: FormSubmissionEvent.REVISE,
      currentState: FormSubmissionState.DRAFT,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, '草稿未提交，不能修订');
  });

  it('SUBMITTED + SUBMIT → 拒绝（重复提交走修订）', () => {
    const r = machine.transition({
      event: FormSubmissionEvent.SUBMIT,
      currentState: FormSubmissionState.SUBMITTED,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, '已提交，重复提交请走修订');
  });

  it('SUBMITTED + REVISE → SUBMITTED（追加修订，状态不变）', () => {
    const r = machine.transition({
      event: FormSubmissionEvent.REVISE,
      currentState: FormSubmissionState.SUBMITTED,
    });
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, FormSubmissionState.SUBMITTED);
  });
});

describe('FormSubmission 聚合（FORM-002）', () => {
  const machine = new DefaultFormSubmissionStateMachine();

  it('草稿提交：DRAFT → SUBMITTED，初始修订号为 1', () => {
    const sub = FormSubmission.createDraft({
      id: 's-1',
      formId: 'f-1',
      versionNumber: 1,
      scope: SCOPE,
      submittedBy: 'u-1',
      values: VALUES,
      now: NOW,
    });
    assert.equal(sub.status, FormSubmissionState.DRAFT);
    assert.equal(sub.revisionNumber, 1);
    assert.equal(sub.submit(machine, NOW), true);
    assert.equal(sub.status, FormSubmissionState.SUBMITTED);
    assert.equal(sub.revisions.length, 1);
  });

  it('未提交不能修订', () => {
    const sub = FormSubmission.createDraft({
      id: 's-2',
      formId: 'f-1',
      versionNumber: 1,
      scope: SCOPE,
      submittedBy: 'u-1',
      values: VALUES,
      now: NOW,
    });
    assert.equal(sub.canRevise(machine), false);
    assert.equal(sub.revise({ name: '李四' }, 'u-1', NOW), false);
  });

  it('已提交修订：追加修订快照，修订号递增，保留历史', () => {
    const sub = FormSubmission.createDraft({
      id: 's-3',
      formId: 'f-1',
      versionNumber: 1,
      scope: SCOPE,
      submittedBy: 'u-1',
      values: VALUES,
      now: NOW,
    });
    sub.submit(machine, NOW);
    assert.equal(sub.revise({ name: '李四', age: 21 }, 'u-2', NOW), true);
    assert.equal(sub.status, FormSubmissionState.SUBMITTED);
    assert.equal(sub.revisionNumber, 2);
    assert.equal(sub.revisions.length, 2);
    assert.deepEqual(sub.values, { name: '李四', age: 21 });
    assert.equal(sub.revisions[1].revisedBy, 'u-2');
  });

  it('已提交重复提交拒绝（须修订）', () => {
    const sub = FormSubmission.createDraft({
      id: 's-4',
      formId: 'f-1',
      versionNumber: 1,
      scope: SCOPE,
      submittedBy: 'u-1',
      values: VALUES,
      now: NOW,
    });
    sub.submit(machine, NOW);
    assert.equal(sub.submit(machine, NOW), false);
    assert.equal(sub.status, FormSubmissionState.SUBMITTED);
  });
});
