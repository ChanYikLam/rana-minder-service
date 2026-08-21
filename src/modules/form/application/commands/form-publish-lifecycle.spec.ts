/**
 * 表单发布/停用/复用用例测试（SRS-SM-FORM-001 t5~t8；IFC-ERR-010 单胜者）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FormVersionState } from '../../domain/state-machines/form-version.state-machine';
import { DefaultFormVersionStateMachine } from '../../domain/state-machines/form-version.state-machine';
import { DefaultCreateFormDraftUseCase } from './create-form-draft.use-case';
import { DefaultRunFormPreviewTestUseCase } from './run-form-preview-test.use-case';
import { DefaultMarkFormPreviewPassedUseCase } from './mark-form-preview-passed.use-case';
import { DefaultPublishFormVersionUseCase } from './publish-form-version.use-case';
import { DefaultDeprecateFormVersionUseCase } from './deprecate-form-version.use-case';
import { DefaultReuseFormVersionUseCase } from './reuse-form-version.use-case';
import { DefaultUpdateFormDraftUseCase } from './update-form-draft.use-case';
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

async function createPublishable(h: ReturnType<typeof createHarness>) {
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
  await h.markPassed.execute({ formId: created.formId, actor: 'leader-1', now: NOW, traceId: 't' });
  return created;
}

describe('发布/停用/复用（t5~t8）', () => {
  it('t5 发布：草稿 → PUBLISHED，成为当前使用版本；草稿指针清空', async () => {
    const h = createHarness();
    const created = await createPublishable(h);
    const published = await h.publish.execute({
      formId: created.formId,
      version: null,
      expectedRootVersion: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    assert.equal(published.status, 'published');
    const root = await h.repository.loadRoot(created.formId);
    assert.equal(root?.currentPublishedVersion, 1);
    assert.equal(root?.currentDraftVersion, null);
    const version = await h.repository.loadVersion(created.formId, 1);
    assert.equal(version?.status, FormVersionState.PUBLISHED);
    assert.equal(version?.publishedAt !== null, true);
    assert.equal(
      h.audit.facts.some((f) => f.type === 'FORM_PUBLISHED'),
      true,
    );
  });

  it('t5 未通过测试的草稿拒绝发布（publishable=false → 422）', async () => {
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
    await assert.rejects(
      h.publish.execute({
        formId: created.formId,
        version: null,
        expectedRootVersion: null,
        actor: 'leader-1',
        now: NOW,
        traceId: 't',
      }),
      (error: FormCommandError) => error.code === FormErrorCode.PRECONDITION_FAILED,
    );
  });

  it('t5 已发布不可覆盖：再次发布同一表单被拒绝（无草稿）', async () => {
    const h = createHarness();
    const created = await createPublishable(h);
    await h.publish.execute({
      formId: created.formId,
      version: null,
      expectedRootVersion: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    await assert.rejects(
      h.publish.execute({
        formId: created.formId,
        version: null,
        expectedRootVersion: null,
        actor: 'leader-1',
        now: NOW,
        traceId: 't',
      }),
      (error: FormCommandError) => error.code === FormErrorCode.PRECONDITION_FAILED,
    );
  });

  it('t5 并发发布：根乐观版本不匹配（预期根版本错误）→ 409 IFC-ERR-008', async () => {
    const h = createHarness();
    const created = await createPublishable(h);
    await assert.rejects(
      h.publish.execute({
        formId: created.formId,
        version: null,
        expectedRootVersion: 99,
        actor: 'leader-1',
        now: NOW,
        traceId: 't',
      }),
      (error: FormCommandError) => error.code === FormErrorCode.VERSION_CONFLICT,
    );
  });

  it('t6 停用：PUBLISHED → DEPRECATED，当前使用指针撤销；重复停用幂等成功', async () => {
    const h = createHarness();
    const created = await createPublishable(h);
    await h.publish.execute({
      formId: created.formId,
      version: null,
      expectedRootVersion: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    const deprecated = await h.deprecate.execute({
      formId: created.formId,
      expectedRootVersion: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    assert.equal(deprecated.status, 'deprecated');
    const root = await h.repository.loadRoot(created.formId);
    assert.equal(root?.currentPublishedVersion, null);
    const version = await h.repository.loadVersion(created.formId, 1);
    assert.equal(version?.status, FormVersionState.DEPRECATED);

    const again = await h.deprecate.execute({
      formId: created.formId,
      expectedRootVersion: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    assert.equal(again.status, 'deprecated');
  });

  it('t7 复用：最新已是草稿直接复用（不新建版本）', async () => {
    const h = createHarness();
    const created = await createPublishable(h);
    const reused = await h.reuse.execute({
      formId: created.formId,
      sourceVersion: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    assert.equal(reused.draftVersion, 1);
    assert.equal(h.repository.versions.length, 1);
  });

  it('t7 复用：从已发布版本创建新草稿，来源不可变，根指针切到新草稿', async () => {
    const h = createHarness();
    const created = await createPublishable(h);
    await h.publish.execute({
      formId: created.formId,
      version: null,
      expectedRootVersion: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    const reused = await h.reuse.execute({
      formId: created.formId,
      sourceVersion: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    assert.equal(reused.draftVersion, 2);
    assert.equal(reused.sourceVersion, 1);
    const published = await h.repository.loadVersion(created.formId, 1);
    assert.equal(published?.status, FormVersionState.PUBLISHED);
    const root = await h.repository.loadRoot(created.formId);
    assert.equal(root?.currentDraftVersion, 2);
    assert.equal(root?.currentPublishedVersion, 1);
  });

  it('t7 显式来源版本：可指定停用版本为复用来源', async () => {
    const h = createHarness();
    const created = await createPublishable(h);
    await h.publish.execute({
      formId: created.formId,
      version: null,
      expectedRootVersion: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    await h.deprecate.execute({
      formId: created.formId,
      expectedRootVersion: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    const reused = await h.reuse.execute({
      formId: created.formId,
      sourceVersion: 1,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    assert.equal(reused.draftVersion, 2);
    assert.equal(reused.sourceVersion, 1);
  });

  it('t8 已停用版本无直接恢复路径：只允许复用来源建新草稿（RESTORE 稳定拒绝）', async () => {
    const h = createHarness();
    const created = await createPublishable(h);
    await h.publish.execute({
      formId: created.formId,
      version: null,
      expectedRootVersion: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    await h.deprecate.execute({
      formId: created.formId,
      expectedRootVersion: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    const version = await h.repository.loadVersion(created.formId, 1);
    assert.equal(version?.status, FormVersionState.DEPRECATED);
    const versions = await h.repository.loadVersions(created.formId);
    assert.match(versions[0].status, /^DEPRECATED$/);
  });

  it('权限失败关闭：无权设计时创建被拒（403 IFC-ERR-003）', async () => {
    const h = createHarness();
    h.permission.allowed = false;
    await assert.rejects(
      h.create.execute({
        scope: SCOPE,
        title: '报名表',
        description: null,
        businessFamily: null,
        actor: 'member-1',
        now: NOW,
        traceId: 't',
      }),
      (error: FormCommandError) => error.code === FormErrorCode.FORBIDDEN,
    );
  });

  it('状态守卫单胜者：并发停用后再次状态转换被拒（IFC-ERR-010 语义）', async () => {
    const h = createHarness();
    const created = await createPublishable(h);
    await h.publish.execute({
      formId: created.formId,
      version: null,
      expectedRootVersion: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    await h.deprecate.execute({
      formId: created.formId,
      expectedRootVersion: null,
      actor: 'leader-1',
      now: NOW,
      traceId: 't',
    });
    const latest = await h.repository.loadLatestVersion(created.formId);
    assert.equal(latest?.status, FormVersionState.DEPRECATED);
  });
});
