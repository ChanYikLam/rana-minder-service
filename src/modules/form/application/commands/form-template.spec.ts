/**
 * 表单克隆/模板库用例测试（FORM-010 克隆；FORM-011 模板库：复制模板、
 * 请求发布、审核批准/拒绝）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FormVersionState } from '../../domain/state-machines/form-version.state-machine';
import { DefaultFormVersionStateMachine } from '../../domain/state-machines/form-version.state-machine';
import { DefaultCreateFormDraftUseCase } from './create-form-draft.use-case';
import { DefaultUpdateFormDraftUseCase } from './update-form-draft.use-case';
import { DefaultRunFormPreviewTestUseCase } from './run-form-preview-test.use-case';
import { DefaultMarkFormPreviewPassedUseCase } from './mark-form-preview-passed.use-case';
import { DefaultPublishFormVersionUseCase } from './publish-form-version.use-case';
import { DefaultCloneFormUseCase } from './clone-form.use-case';
import { DefaultCopyTemplateUseCase } from './copy-template.use-case';
import { DefaultRequestTemplatePublicationUseCase } from './request-template-publication.use-case';
import { DefaultReviewTemplatePublicationUseCase } from './review-template-publication.use-case';
import {
  InMemoryFormDefinitionRepository,
  StubFormDesignPermission,
  StubFormAudit,
  InMemoryFormIdempotencyStore,
  StubProfileFieldDirectory,
} from '../testing/form-test-support';
import type { FormScope } from '../../domain/models/form-scope';
import { FormCommandError, FormErrorCode } from '../errors';

const machine = new DefaultFormVersionStateMachine();
const SCOPE: FormScope = { kind: 'club', ownerId: 'club-1' };
const NOW = new Date('2026-08-20T08:00:00.000Z');

function createHarness() {
  const repository = new InMemoryFormDefinitionRepository();
  const permission = new StubFormDesignPermission();
  const audit = new StubFormAudit();
  const idempotency = new InMemoryFormIdempotencyStore();
  const directory = new StubProfileFieldDirectory();
  return {
    repository,
    permission,
    audit,
    idempotency,
    create: new DefaultCreateFormDraftUseCase(repository, permission, audit, idempotency),
    update: new DefaultUpdateFormDraftUseCase(repository, permission, directory, audit, machine),
    runTest: new DefaultRunFormPreviewTestUseCase(repository, permission, audit, machine),
    markPassed: new DefaultMarkFormPreviewPassedUseCase(repository, permission, audit, machine),
    publish: new DefaultPublishFormVersionUseCase(
      repository,
      permission,
      directory,
      audit,
      machine,
    ),
    clone: new DefaultCloneFormUseCase(repository, permission, audit, idempotency),
    copyTemplate: new DefaultCopyTemplateUseCase(repository, permission, audit, idempotency),
    request: new DefaultRequestTemplatePublicationUseCase(
      repository,
      permission,
      audit,
      idempotency,
    ),
    review: new DefaultReviewTemplatePublicationUseCase(repository, permission, audit),
  };
}

const FIELDS = [
  { id: 'name', title: '姓名', type: 'text', required: true },
  { id: 'note', title: '备注', type: 'textarea' },
];

const NORMALIZED_FIELDS = [
  { id: 'name', title: '姓名', type: 'text', required: true, permission: 'read_write' },
  { id: 'note', title: '备注', type: 'textarea', required: false, permission: 'read_write' },
];

async function createPublishable(
  h: ReturnType<typeof createHarness>,
  title = '招新报名表',
): Promise<{ formId: string; publishedVersion: number }> {
  const created = await h.create.execute({
    scope: SCOPE,
    title,
    description: null,
    businessFamily: 'recruitment_application',
    actor: 'leader-1',
    now: NOW,
    traceId: 't',
  });
  const updated = await h.update.execute({
    formId: created.formId,
    expectedVersion: 1,
    fields: FIELDS,
    actor: 'leader-1',
    now: NOW,
    traceId: 't',
  });
  await h.runTest.execute({
    formId: created.formId,
    result: 'PASSED',
    summary: { files: 0 },
    actor: 'leader-1',
    now: NOW,
    traceId: 't',
  });
  await h.markPassed.execute({ formId: created.formId, actor: 'leader-1', now: NOW, traceId: 't' });
  await h.publish.execute({
    formId: created.formId,
    version: null,
    expectedRootVersion: null,
    actor: 'leader-1',
    now: NOW,
    traceId: 't',
  });
  return { formId: created.formId, publishedVersion: updated.version };
}

describe('克隆与模板库（FORM-010/011）', () => {
  it('克隆：复制本社团已发布表单为独立草稿，结构复制不含数据（FORM-010）', async () => {
    const h = createHarness();
    const source = await createPublishable(h);
    const cloned = await h.clone.execute({
      sourceFormId: source.formId,
      targetScope: SCOPE,
      title: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    assert.notEqual(cloned.formId, source.formId);
    assert.equal(cloned.sourceFormId, source.formId);
    assert.equal(cloned.draftVersion, 1);
    const draft = await h.repository.loadVersion(cloned.formId, 1);
    assert.equal(draft?.status, FormVersionState.DRAFT);
    assert.deepEqual(draft?.fields, NORMALIZED_FIELDS);
    assert.equal(draft?.sourceFormId, source.formId);
  });

  it('克隆幂等：同键同摘要重放原结果', async () => {
    const h = createHarness();
    const source = await createPublishable(h);
    const first = await h.clone.execute({
      sourceFormId: source.formId,
      targetScope: SCOPE,
      title: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
      idempotencyKey: 'clone-1',
    });
    const replayed = await h.clone.execute({
      sourceFormId: source.formId,
      targetScope: SCOPE,
      title: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
      idempotencyKey: 'clone-1',
    });
    assert.equal(replayed.formId, first.formId);
    assert.equal(h.repository.roots.filter((root) => root.id === first.formId).length, 1);
  });

  it('克隆独立演进：修改克隆草稿不影响源表单', async () => {
    const h = createHarness();
    const source = await createPublishable(h);
    const cloned = await h.clone.execute({
      sourceFormId: source.formId,
      targetScope: SCOPE,
      title: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    const updated = await h.update.execute({
      formId: cloned.formId,
      expectedVersion: 1,
      fields: [{ id: 'grade', title: '年级', type: 'text' }],
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    assert.equal(updated.version, 2);
    const sourceInitial = await h.repository.loadVersion(source.formId, 1);
    assert.deepEqual(sourceInitial?.fields, []);
    const sourceDraft = await h.repository.loadVersion(source.formId, 2);
    assert.deepEqual(sourceDraft?.fields, NORMALIZED_FIELDS);
    const cloneDraft = await h.repository.loadVersion(cloned.formId, 2);
    assert.deepEqual(cloneDraft?.fields, [
      { id: 'grade', title: '年级', type: 'text', required: false, permission: 'read_write' },
    ]);
  });

  it('跨作用域克隆拒绝（FORM-010 限定本社团）', async () => {
    const h = createHarness();
    const source = await createPublishable(h);
    await assert.rejects(
      h.clone.execute({
        sourceFormId: source.formId,
        targetScope: { kind: 'club', ownerId: 'other-club' },
        title: null,
        actor: 'leader-1',
        now: NOW,
        traceId: 't',
      }),
      (error: FormCommandError) => error.code === FormErrorCode.FORBIDDEN,
    );
  });

  it('复制模板：从平台模板建独立草稿；对象选项清空须重新配置（FORM-011）', async () => {
    const h = createHarness();
    const source = await createPublishable(h);
    const requested = await h.request.execute({
      formId: source.formId,
      note: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    await h.review.execute({
      publicationId: requested.publicationId,
      decision: 'APPROVE',
      reason: null,
      actor: 'super-1',
      now: NOW,
      traceId: 't',
    });
    const template = await h.repository.listByScope({ kind: 'platform', ownerId: null });
    assert.equal(template.length, 1);

    const copied = await h.copyTemplate.execute({
      templateId: template[0].id,
      targetScope: SCOPE,
      title: '借用模板',
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    assert.notEqual(copied.formId, source.formId);
    assert.equal(copied.templateId, template[0].id);
    const draft = await h.repository.loadVersion(copied.formId, 1);
    assert.deepEqual(draft?.fields, NORMALIZED_FIELDS);
    assert.equal(draft?.status, FormVersionState.DRAFT);
  });

  it('请求模板发布：PENDING + 审计 FORM_TEMPLATE_PUBLICATION_REQUESTED', async () => {
    const h = createHarness();
    const source = await createPublishable(h);
    const requested = await h.request.execute({
      formId: source.formId,
      note: '优秀模板',
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    assert.equal(requested.status, 'PENDING');
    assert.equal(
      h.audit.facts.some((fact) => fact.type === 'FORM_TEMPLATE_PUBLICATION_REQUESTED'),
      true,
    );
    const publication = await h.repository.loadTemplatePublication(requested.publicationId);
    assert.equal(publication?.status, 'PENDING');
    assert.equal(publication?.sourceVersion, 2);
  });

  it('审核批准：APPROVED + 物化平台模板（FORM-011）', async () => {
    const h = createHarness();
    const source = await createPublishable(h);
    const requested = await h.request.execute({
      formId: source.formId,
      note: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    const decided = await h.review.execute({
      publicationId: requested.publicationId,
      decision: 'APPROVE',
      reason: null,
      actor: 'super-1',
      now: NOW,
      traceId: 't',
    });
    assert.equal(decided.status, 'APPROVED');
    assert.notEqual(decided.templateFormId, null);
    assert.equal(
      h.audit.facts.some((fact) => fact.type === 'FORM_TEMPLATE_PUBLICATION_DECIDED'),
      true,
    );
    const templateRoot = await h.repository.loadRoot(decided.templateFormId!);
    assert.equal(templateRoot?.kind, 'TEMPLATE');
    assert.equal(templateRoot?.scope.kind, 'platform');
    const templateVersion = await h.repository.loadVersion(decided.templateFormId!, 1);
    assert.equal(templateVersion?.status, FormVersionState.PUBLISHED);
    assert.deepEqual(templateVersion?.fields, NORMALIZED_FIELDS);
  });

  it('审核拒绝：REJECTED + 不物化模板', async () => {
    const h = createHarness();
    const source = await createPublishable(h);
    const requested = await h.request.execute({
      formId: source.formId,
      note: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    const decided = await h.review.execute({
      publicationId: requested.publicationId,
      decision: 'REJECT',
      reason: '含敏感字段',
      actor: 'super-1',
      now: NOW,
      traceId: 't',
    });
    assert.equal(decided.status, 'REJECTED');
    assert.equal(decided.templateFormId, null);
    const publication = await h.repository.loadTemplatePublication(requested.publicationId);
    assert.equal(publication?.status, 'REJECTED');
    assert.equal(publication?.decisionReason, '含敏感字段');
  });

  it('审核终态不可重复裁决（状态守卫单胜者）', async () => {
    const h = createHarness();
    const source = await createPublishable(h);
    const requested = await h.request.execute({
      formId: source.formId,
      note: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    await h.review.execute({
      publicationId: requested.publicationId,
      decision: 'APPROVE',
      reason: null,
      actor: 'super-1',
      now: NOW,
      traceId: 't',
    });
    await assert.rejects(
      h.review.execute({
        publicationId: requested.publicationId,
        decision: 'REJECT',
        reason: '重复裁决',
        actor: 'super-1',
        now: NOW,
        traceId: 't',
      }),
      (error: FormCommandError) => error.code === FormErrorCode.PRECONDITION_FAILED,
    );
  });

  it('权限失败关闭：无权审核（403 IFC-ERR-003）', async () => {
    const h = createHarness();
    const source = await createPublishable(h);
    const requested = await h.request.execute({
      formId: source.formId,
      note: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    h.permission.platformAllowed = false;
    await assert.rejects(
      h.review.execute({
        publicationId: requested.publicationId,
        decision: 'APPROVE',
        reason: null,
        actor: 'member-1',
        now: NOW,
        traceId: 't',
      }),
      (error: FormCommandError) => error.code === FormErrorCode.FORBIDDEN,
    );
    const publication = await h.repository.loadTemplatePublication(requested.publicationId);
    assert.equal(publication?.status, 'PENDING');
  });
});
