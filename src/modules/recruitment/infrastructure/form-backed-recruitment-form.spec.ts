import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FormBackedRecruitmentForm } from './form-backed-recruitment-form';
import type { FormSubmissionSnapshot } from '../../form/domain/models/form-submission';
import type { FormSubmissionRepository } from '../../form/application/ports/form-submission-repository.port';

const makeSnapshot = (overrides: Partial<FormSubmissionSnapshot> = {}): FormSubmissionSnapshot => ({
  id: 'sub-1',
  formId: 'form-1',
  versionNumber: 3,
  scope: { kind: 'platform', ownerId: null },
  submittedBy: 'applicant-1',
  values: { name: '张三' },
  status: 'SUBMITTED',
  revisionNumber: 1,
  revisions: [],
  createdAt: new Date('2026-08-24T00:00:00.000Z'),
  updatedAt: new Date('2026-08-24T00:00:00.000Z'),
  ...overrides,
});

const makeRepo = (rows: FormSubmissionSnapshot[]): FormSubmissionRepository => ({
  load: async (id: string) => rows.find((r) => r.id === id) ?? null,
  loadBySubmitter: async () => null,
  listByScope: async () => [],
  listByForm: async () => [],
  insert: async () => undefined,
  save: async () => undefined,
});

describe('FormBackedRecruitmentForm（4.4b 表单真集成收口）', () => {
  it('委托 form 提交仓储读取快照 → found + 映射招新视图（不泄露答案明细）', async () => {
    const form = new FormBackedRecruitmentForm(makeRepo([makeSnapshot()]));
    const result = await form.loadSubmission({ formId: 'form-1', submissionId: 'sub-1' });
    assert.equal(result.outcome, 'found');
    if (result.outcome === 'found') {
      assert.deepEqual(result.submission, {
        id: 'sub-1',
        status: 'SUBMITTED',
        submittedBy: 'applicant-1',
      });
    }
  });

  it('提交不存在 → not-found', async () => {
    const form = new FormBackedRecruitmentForm(makeRepo([]));
    const result = await form.loadSubmission({ formId: 'form-1', submissionId: 'missing' });
    assert.equal(result.outcome, 'not-found');
  });

  it('归属校验：提交属于其他表单 → forbidden（防跨表单读取，不误报不存在）', async () => {
    const form = new FormBackedRecruitmentForm(makeRepo([makeSnapshot()]));
    const result = await form.loadSubmission({ formId: 'form-other', submissionId: 'sub-1' });
    assert.equal(result.outcome, 'forbidden');
  });
});
