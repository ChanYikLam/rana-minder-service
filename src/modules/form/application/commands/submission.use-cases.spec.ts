/**
 * 表单提交/修订用例（FORM-002）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FormVersion } from '../../domain/models/form-version';
import type { FormFieldSet } from '../../domain/models/form-field';
import {
  InMemoryFormDefinitionRepository,
  InMemoryFormSubmissionRepository,
  StubFormAudit,
  InMemoryFormIdempotencyStore,
  StubFormFillPermission,
} from '../testing/form-test-support';
import { DefaultSubmitFormUseCase } from './submit-form.use-case';
import { DefaultReviseSubmissionUseCase } from './revise-submission.use-case';
import { DefaultListSubmissionsQuery } from '../queries/list-submissions.query';
import type { FormScope } from '../../domain/models/form-scope';

const NOW = new Date('2026-08-21T08:00:00.000Z');
const SCOPE: FormScope = { kind: 'club', ownerId: 'club-1' };
const FIELDS: FormFieldSet = [
  { id: 'name', title: '姓名', type: 'text', required: true, permission: 'read_write' },
];

function buildHarness() {
  const definitions = new InMemoryFormDefinitionRepository();
  const submissions = new InMemoryFormSubmissionRepository();
  const fill = new StubFormFillPermission();
  const audit = new StubFormAudit();
  const idempotency = new InMemoryFormIdempotencyStore();
  const submit = new DefaultSubmitFormUseCase(submissions, definitions, fill, audit, idempotency);
  const revise = new DefaultReviseSubmissionUseCase(submissions, definitions, fill, audit);
  const list = new DefaultListSubmissionsQuery(submissions);
  return { definitions, submissions, fill, audit, submit, revise, list, idempotency };
}

function seedPublished(
  definitions: InMemoryFormDefinitionRepository,
  formId: string,
  versionNumber: number,
): void {
  const version = FormVersion.createPublished({
    id: `v-${formId}-${versionNumber}`,
    formId,
    versionNumber,
    fields: FIELDS,
    sourceFormId: null,
    sourceVersion: null,
    publishedBy: 'admin',
    now: NOW,
  });
  definitions.versions.push(version.toSnapshot());
}

describe('SubmitFormUseCase（FORM-002）', () => {
  it('填写权限拒绝 → forbidden', async () => {
    const h = buildHarness();
    seedPublished(h.definitions, 'f-1', 1);
    await assert.rejects(
      h.submit.execute({
        formId: 'f-1',
        versionNumber: 1,
        scope: SCOPE,
        submittedBy: 'u-1',
        values: { name: '张三' },
        actor: 'u-1',
        now: NOW,
      }),
      (err: Error) => err.message.includes('无权填写'),
    );
  });

  it('填写权限放行后成功提交（SUBMITTED）', async () => {
    const h = buildHarness();
    h.fill.allowed = true;
    seedPublished(h.definitions, 'f-1', 1);
    const result = await h.submit.execute({
      formId: 'f-1',
      versionNumber: 1,
      scope: SCOPE,
      submittedBy: 'u-1',
      values: { name: '张三' },
      actor: 'u-1',
      now: NOW,
    });
    const saved = await h.submissions.load(result.submissionId);
    assert.equal(saved?.status, 'SUBMITTED');
    assert.equal(saved?.revisionNumber, 1);
  });

  it('版本非发布 → 拒绝', async () => {
    const h = buildHarness();
    h.fill.allowed = true;
    const definitions = h.definitions;
    definitions.versions.push(
      FormVersion.createDraft({
        id: 'v-f-1-1',
        formId: 'f-1',
        versionNumber: 1,
        fields: FIELDS,
        sourceFormId: null,
        sourceVersion: null,
        createdBy: 'admin',
        now: NOW,
      }).toSnapshot(),
    );
    await assert.rejects(
      h.submit.execute({
        formId: 'f-1',
        versionNumber: 1,
        scope: SCOPE,
        submittedBy: 'u-1',
        values: { name: '张三' },
        actor: 'u-1',
        now: NOW,
      }),
      (err: Error) => err.message.includes('仅已发布版本'),
    );
  });

  it('答案校验失败 → 拒绝', async () => {
    const h = buildHarness();
    h.fill.allowed = true;
    seedPublished(h.definitions, 'f-1', 1);
    await assert.rejects(
      h.submit.execute({
        formId: 'f-1',
        versionNumber: 1,
        scope: SCOPE,
        submittedBy: 'u-1',
        values: {},
        actor: 'u-1',
        now: NOW,
      }),
      (err: Error) => err.message.includes('表单答案不符合字段约束'),
    );
  });

  it('同一提交者重复提交 → 拒绝（可修订）', async () => {
    const h = buildHarness();
    h.fill.allowed = true;
    seedPublished(h.definitions, 'f-1', 1);
    await h.submit.execute({
      formId: 'f-1',
      versionNumber: 1,
      scope: SCOPE,
      submittedBy: 'u-1',
      values: { name: '张三' },
      actor: 'u-1',
      now: NOW,
    });
    await assert.rejects(
      h.submit.execute({
        formId: 'f-1',
        versionNumber: 1,
        scope: SCOPE,
        submittedBy: 'u-1',
        values: { name: '李四' },
        actor: 'u-1',
        now: NOW,
      }),
      (err: Error) => err.message.includes('已提交过当前版本'),
    );
  });

  it('hidden 字段值被剔除，不落库（防客户端注入）', async () => {
    const h = buildHarness();
    h.fill.allowed = true;
    // 版本含 hidden 字段 serverToken（服务端维护，客户端不得写入）
    const version = FormVersion.createPublished({
      id: 'v-f-hide-1',
      formId: 'f-hide',
      versionNumber: 1,
      fields: [
        { id: 'name', title: '姓名', type: 'text', required: true, permission: 'read_write' },
        { id: 'serverToken', title: '令牌', type: 'text', required: false, permission: 'hidden' },
      ],
      sourceFormId: null,
      sourceVersion: null,
      publishedBy: 'admin',
      now: NOW,
    });
    h.definitions.versions.push(version.toSnapshot());
    const result = await h.submit.execute({
      formId: 'f-hide',
      versionNumber: 1,
      scope: SCOPE,
      submittedBy: 'u-1',
      values: { name: '张三', serverToken: 'EVIL' },
      actor: 'u-1',
      now: NOW,
    });
    const saved = await h.submissions.load(result.submissionId);
    assert.equal(saved?.values.serverToken, undefined);
    assert.equal(saved?.values.name, '张三');
  });

  it('幂等占位在业务失败后被释放，同键可重试恢复', async () => {
    const h = buildHarness();
    h.fill.allowed = true;
    seedPublished(h.definitions, 'f-1', 1);
    // 首次提交成功后，同一提交者携带新幂等键再次提交会命中重复提交业务拒绝；
    // 该键是新占位（begin 成功），此前会卡死在 PROCESSING，现应被 release 释放。
    await h.submit.execute({
      formId: 'f-1',
      versionNumber: 1,
      scope: SCOPE,
      submittedBy: 'u-1',
      values: { name: '张三' },
      actor: 'u-1',
      now: NOW,
    });
    await assert.rejects(
      h.submit.execute({
        formId: 'f-1',
        versionNumber: 1,
        scope: SCOPE,
        submittedBy: 'u-1',
        values: { name: '李四' },
        actor: 'u-1',
        now: NOW,
        idempotencyKey: 'k-retry',
      }),
      (err: Error) => err.message.includes('已提交过当前版本'),
    );
    // 幂等记录已释放：同键重提应重新占位（inserted=true）而非返回 PROCESSING
    const claim = await h.idempotency.claim({
      scopeKey: 'submit:club:club-1:f-1:1:u-1',
      idempotencyKey: 'k-retry',
      semanticHash: 'any-hash',
    });
    assert.equal(claim.inserted, true);
  });
});

describe('ReviseSubmissionUseCase / ListSubmissions（FORM-002）', () => {
  it('已提交记录修订：修订号递增并保留历史', async () => {
    const h = buildHarness();
    h.fill.allowed = true;
    seedPublished(h.definitions, 'f-1', 1);
    const result = await h.submit.execute({
      formId: 'f-1',
      versionNumber: 1,
      scope: SCOPE,
      submittedBy: 'u-1',
      values: { name: '张三' },
      actor: 'u-1',
      now: NOW,
    });
    const revised = await h.revise.execute({
      submissionId: result.submissionId,
      values: { name: '张三丰' },
      actor: 'u-1',
      now: NOW,
    });
    assert.equal(revised.revisionNumber, 2);
    const saved = await h.submissions.load(result.submissionId);
    assert.equal(saved?.revisionNumber, 2);
    assert.deepEqual(saved?.values, { name: '张三丰' });
    assert.equal(saved?.revisions.length, 2);
  });

  it('按作用域列出提交', async () => {
    const h = buildHarness();
    h.fill.allowed = true;
    seedPublished(h.definitions, 'f-1', 1);
    await h.submit.execute({
      formId: 'f-1',
      versionNumber: 1,
      scope: SCOPE,
      submittedBy: 'u-1',
      values: { name: '张三' },
      actor: 'u-1',
      now: NOW,
    });
    const list = await h.list.execute({ scope: SCOPE });
    assert.equal(list.length, 1);
  });
});
