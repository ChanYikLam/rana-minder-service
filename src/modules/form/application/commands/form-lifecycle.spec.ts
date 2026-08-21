/**
 * 表单生命周期用例测试（SRS-SM-FORM-001 t1~t8 全链路 + 并发/幂等/权限）。
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
import { DefaultDeprecateFormVersionUseCase } from './deprecate-form-version.use-case';
import { DefaultReuseFormVersionUseCase } from './reuse-form-version.use-case';
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
    deprecate: new DefaultDeprecateFormVersionUseCase(repository, permission, audit, machine),
    reuse: new DefaultReuseFormVersionUseCase(repository, permission, audit, machine),
  };
}

const FIELDS = [
  { id: 'name', title: '姓名', type: 'text', required: true },
  { id: 'note', title: '备注', type: 'textarea' },
];

describe('表单生命周期（t1~t8）', () => {
  it('t1 创建：根 + 草稿 v1 原子落位，审计记录', async () => {
    const h = createHarness();
    const result = await h.create.execute({
      scope: SCOPE,
      title: '招新报名表',
      description: null,
      businessFamily: 'recruitment_application',
      actor: 'leader-1',
      now: NOW,
      traceId: 'trace-1',
    });
    assert.equal(result.draftVersion, 1);
    const root = await h.repository.loadRoot(result.formId);
    assert.equal(root?.currentDraftVersion, 1);
    assert.equal(root?.currentPublishedVersion, null);
    assert.equal(h.audit.facts[0].type, 'FORM_DRAFT_CREATED');
  });

  it('t1 幂等：同键同摘要重放原结果；同键异摘要拒绝 IFC-ERR-009', async () => {
    const h = createHarness();
    const first = await h.create.execute({
      scope: SCOPE,
      title: '报名表',
      description: null,
      businessFamily: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 'trace-1',
      idempotencyKey: 'idem-1',
    });
    const replayed = await h.create.execute({
      scope: SCOPE,
      title: '报名表',
      description: null,
      businessFamily: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 'trace-2',
      idempotencyKey: 'idem-1',
    });
    assert.equal(replayed.formId, first.formId);
    assert.equal(h.repository.roots.length, 1);

    await assert.rejects(
      h.create.execute({
        scope: SCOPE,
        title: '另一个标题',
        description: null,
        businessFamily: null,
        actor: 'leader-1',
        now: NOW,
        traceId: 'trace-3',
        idempotencyKey: 'idem-1',
      }),
      (error: FormCommandError) => error.code === FormErrorCode.IDEMPOTENCY_CONFLICT,
    );
  });

  it('t2 编辑：原子存新草稿版本；旧版本编辑拒绝（乐观锁 IFC-ERR-008）', async () => {
    const h = createHarness();
    const created = await h.create.execute({
      scope: SCOPE,
      title: '报名表',
      description: null,
      businessFamily: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    const saved = await h.update.execute({
      formId: created.formId,
      expectedVersion: 1,
      fields: FIELDS,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    assert.equal(saved.version, 2);
    const versions = await h.repository.loadVersions(created.formId);
    assert.equal(versions.length, 2);

    await assert.rejects(
      h.update.execute({
        formId: created.formId,
        expectedVersion: 1,
        fields: FIELDS,
        actor: 'leader-1',
        now: NOW,
        traceId: 't',
      }),
      (error: FormCommandError) => error.code === FormErrorCode.VERSION_CONFLICT,
    );
  });

  it('t2 草稿变更使测试通过标志失效（编辑后 publishable=false）', async () => {
    const h = createHarness();
    const created = await h.create.execute({
      scope: SCOPE,
      title: '报名表',
      description: null,
      businessFamily: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    await h.update.execute({
      formId: created.formId,
      expectedVersion: 1,
      fields: FIELDS,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    const latest = await h.repository.loadLatestVersion(created.formId);
    assert.equal(latest?.publishable, false);
  });

  it('t3 预览/测试：DRAFT → PREVIEW_TESTING，测试结果绑定草稿版本', async () => {
    const h = createHarness();
    const created = await h.create.execute({
      scope: SCOPE,
      title: '报名表',
      description: null,
      businessFamily: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    const run = await h.runTest.execute({
      formId: created.formId,
      result: 'PASSED',
      summary: { files: 2, sent: 0 },
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    assert.equal(run.versionNumber, 1);
    const latest = await h.repository.loadLatestVersion(created.formId);
    assert.equal(latest?.status, FormVersionState.PREVIEW_TESTING);
    const test = await h.repository.loadPreviewTest(created.formId, 1);
    assert.equal(test?.result, 'PASSED');
  });

  it('t3 测试失败：回 DRAFT 且不可发布', async () => {
    const h = createHarness();
    const created = await h.create.execute({
      scope: SCOPE,
      title: '报名表',
      description: null,
      businessFamily: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    await h.runTest.execute({
      formId: created.formId,
      result: 'FAILED',
      summary: {},
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    const latest = await h.repository.loadLatestVersion(created.formId);
    assert.equal(latest?.status, FormVersionState.DRAFT);
    assert.equal(latest?.publishable, false);
  });

  it('t4 测试通过：PASSED → DRAFT（可发布，不自动发布）', async () => {
    const h = createHarness();
    const created = await h.create.execute({
      scope: SCOPE,
      title: '报名表',
      description: null,
      businessFamily: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    await h.runTest.execute({
      formId: created.formId,
      result: 'PASSED',
      summary: {},
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    const passed = await h.markPassed.execute({
      formId: created.formId,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    assert.equal(passed.publishable, true);
    const latest = await h.repository.loadLatestVersion(created.formId);
    assert.equal(latest?.status, FormVersionState.DRAFT);
    assert.equal(latest?.publishable, true);
  });

  it('t4 前置：未通过测试时拒绝确认（无 PASSED 记录）', async () => {
    const h = createHarness();
    const created = await h.create.execute({
      scope: SCOPE,
      title: '报名表',
      description: null,
      businessFamily: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    await h.runTest.execute({
      formId: created.formId,
      result: 'FAILED',
      summary: {},
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    await assert.rejects(
      h.markPassed.execute({ formId: created.formId, actor: 'leader-1', now: NOW, traceId: 't' }),
      (error: FormCommandError) => error.code === FormErrorCode.PRECONDITION_FAILED,
    );
  });
});
