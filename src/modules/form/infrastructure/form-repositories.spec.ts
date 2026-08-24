/**
 * form PostgreSQL 仓储测试（FakeDbAdapter 全链路）。
 *
 * 覆盖：根/版本/预览测试/模板申请读写往返、乐观保存守卫（0 行冲突）、
 * 状态守卫单胜者、版本号冲突、列表排序、幂等两阶段（claim/complete/readResult）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDbAdapter } from '../../../shared/testing/fake-db-adapter';
import { FormUnitOfWork } from './unit-of-work';
import { PostgresFormDefinitionRepository } from './postgres-form-definition.repository';
import { PostgresFormIdempotencyStore } from './postgres-form-idempotency-store';
import { FormDefinition } from '../domain/models/form-definition';
import { FormVersion } from '../domain/models/form-version';
import { FormVersionState } from '../domain/state-machines/form-version.state-machine';
import { DefaultFormVersionStateMachine } from '../domain/state-machines/form-version.state-machine';
import type { FormScope } from '../domain/models/form-scope';

const CLUB: FormScope = { kind: 'club', ownerId: 'club-1' };
const NOW = new Date('2026-08-20T08:00:00.000Z');

function createHarness() {
  const db = new FakeDbAdapter();
  const uow = new FormUnitOfWork(db);
  const repository = new PostgresFormDefinitionRepository(db, uow);
  const idempotency = new PostgresFormIdempotencyStore(db, uow);
  return { db, uow, repository, idempotency };
}

function rootSnapshot(id: string) {
  const root = FormDefinition.create({
    id,
    scope: CLUB,
    kind: 'FORM',
    title: '报名表',
    description: null,
    businessFamily: 'recruitment',
    createdBy: 'leader-1',
    now: NOW,
  });
  root.pointDraft(1, NOW);
  return root;
}

function versionSnapshot(formId: string, versionNumber: number) {
  return FormVersion.createDraft({
    id: `v-${formId}-${versionNumber}`,
    formId,
    versionNumber,
    fields: [{ id: 'name', title: '姓名', type: 'text', required: true, permission: 'read_write' }],
    sourceFormId: null,
    sourceVersion: null,
    createdBy: 'leader-1',
    now: NOW,
  }).toSnapshot();
}

describe('PostgresFormDefinitionRepository（FakeDbAdapter 全链路）', () => {
  it('创建→加载往返：根与版本持久化，jsonb 字段解析回对象', async () => {
    const h = createHarness();
    await h.uow.run({ kind: 'single', subjectId: 'leader-1' }, async () => {
      const root = rootSnapshot('f-1');
      await h.repository.insertVersion(versionSnapshot('f-1', 1));
      await h.repository.saveRoot(root.toSnapshot(), 0);
      const loaded = await h.repository.loadRoot('f-1');
      assert.equal(loaded?.title, '报名表');
      assert.equal(loaded?.currentDraftVersion, 1);
      assert.equal(loaded?.version, 1);
      const version = await h.repository.loadVersion('f-1', 1);
      assert.equal(version?.status, FormVersionState.DRAFT);
      assert.deepEqual(version?.fields, [
        { id: 'name', title: '姓名', type: 'text', required: true, permission: 'read_write' },
      ]);
    });
  });

  it('乐观保存守卫：期望根版本不匹配 → 0 行冲突', async () => {
    const h = createHarness();
    await h.uow.run({ kind: 'single', subjectId: 'leader-1' }, async () => {
      const root = rootSnapshot('f-1');
      await h.repository.insertVersion(versionSnapshot('f-1', 1));
      await h.repository.saveRoot(root.toSnapshot(), 0);
      await assert.rejects(h.repository.saveRoot(root.toSnapshot(), 5), /版本冲突/);
    });
  });

  it('状态守卫：期望状态不匹配 → 0 行冲突（并发单胜者）', async () => {
    const h = createHarness();
    await h.uow.run({ kind: 'single', subjectId: 'leader-1' }, async () => {
      const root = rootSnapshot('f-1');
      await h.repository.insertVersion(versionSnapshot('f-1', 1));
      await h.repository.saveRoot(root.toSnapshot(), 0);
      const stale = FormVersion.fromSnapshot((await h.repository.loadVersion('f-1', 1))!);
      stale.markPreviewFailed(new DefaultFormVersionStateMachine(), NOW);
      await h.repository.saveVersionWithStatusGuard(stale.toSnapshot(), FormVersionState.DRAFT);
      const latest = await h.repository.loadVersion('f-1', 1);
      assert.equal(latest?.status, FormVersionState.DRAFT);
      await assert.rejects(
        h.repository.saveVersionWithStatusGuard(stale.toSnapshot(), FormVersionState.PUBLISHED),
        /状态守卫/,
      );
    });
  });

  it('版本号冲突：重复插入同一版本号 → 冲突', async () => {
    const h = createHarness();
    await h.uow.run({ kind: 'single', subjectId: 'leader-1' }, async () => {
      await h.repository.insertVersion(versionSnapshot('f-1', 1));
      await assert.rejects(h.repository.insertVersion(versionSnapshot('f-1', 1)), /版本号冲突/);
    });
  });

  it('列表按作用域过滤（IS NOT DISTINCT FROM），平台作用域 owner 为 null', async () => {
    const h = createHarness();
    await h.uow.run({ kind: 'single', subjectId: 'super-1' }, async () => {
      const platformRoot = FormDefinition.create({
        id: 't-1',
        scope: { kind: 'platform', ownerId: null },
        kind: 'TEMPLATE',
        title: '模板',
        description: null,
        businessFamily: null,
        createdBy: 'super-1',
        now: NOW,
      });
      platformRoot.pointPublished(1, NOW);
      await h.repository.insertVersion(versionSnapshot('t-1', 1));
      await h.repository.saveRoot(platformRoot.toSnapshot(), 0);
      const list = await h.repository.listByScope({ kind: 'platform', ownerId: null });
      assert.equal(list.length, 1);
      assert.equal(list[0].kind, 'TEMPLATE');
    });
  });

  it('最新版本查询：ORDER BY version_number DESC LIMIT 1', async () => {
    const h = createHarness();
    await h.uow.run({ kind: 'single', subjectId: 'leader-1' }, async () => {
      const root = rootSnapshot('f-1');
      await h.repository.insertVersion(versionSnapshot('f-1', 1));
      await h.repository.insertVersion(versionSnapshot('f-1', 2));
      await h.repository.saveRoot(root.toSnapshot(), 0);
      const latest = await h.repository.loadLatestVersion('f-1');
      assert.equal(latest?.versionNumber, 2);
    });
  });

  it('预览测试保存与读取往返', async () => {
    const h = createHarness();
    await h.uow.run({ kind: 'single', subjectId: 'leader-1' }, async () => {
      await h.repository.savePreviewTest({
        id: 'pt-1',
        formId: 'f-1',
        versionNumber: 1,
        result: 'PASSED',
        summary: { files: 0 },
        testedBy: 'leader-1',
        testedAt: NOW,
      });
      const test = await h.repository.loadPreviewTest('f-1', 1);
      assert.equal(test?.result, 'PASSED');
      assert.deepEqual(test?.summary, { files: 0 });
    });
  });

  it('模板申请状态守卫：终态不可覆盖（PENDING → APPROVED 后再次写入拒绝）', async () => {
    const h = createHarness();
    await h.uow.run({ kind: 'single', subjectId: 'super-1' }, async () => {
      const root = rootSnapshot('f-1');
      await h.repository.insertVersion(versionSnapshot('f-1', 1));
      await h.repository.saveRoot(root.toSnapshot(), 0);
      const snapshot = {
        id: 'pub-1',
        formId: 'f-1',
        sourceVersion: 1,
        status: 'APPROVED' as const,
        note: null,
        requestedBy: 'leader-1',
        requestedAt: NOW,
        decidedBy: 'super-1',
        decidedAt: NOW,
        decisionReason: null,
        templateFormId: 't-1',
        version: 1,
      };
      await h.repository.saveTemplatePublication({ ...snapshot, status: 'PENDING', version: 0 });
      await h.repository.saveTemplatePublicationWithStatusGuard(snapshot);
      const loaded = await h.repository.loadTemplatePublication('pub-1');
      assert.equal(loaded?.status, 'APPROVED');
      await assert.rejects(
        h.repository.saveTemplatePublicationWithStatusGuard({
          ...snapshot,
          status: 'REJECTED',
          decisionReason: 'x',
        }),
        /状态守卫/,
      );
      const after = await h.repository.loadTemplatePublication('pub-1');
      assert.equal(after?.status, 'APPROVED');
    });
  });
});

describe('PostgresFormIdempotencyStore（IFC-GEN-006 两阶段）', () => {
  it('claim 新占位 → complete 回填 → 重放 readResult 得原结果', async () => {
    const h = createHarness();
    await h.uow.run({ kind: 'single', subjectId: 'leader-1' }, async () => {
      const first = await h.idempotency.claim({
        scopeKey: 'create-draft:club:club-1',
        idempotencyKey: 'k-1',
        semanticHash: 'hash-a',
      });
      assert.equal(first.inserted, true);
      await h.idempotency.complete({
        scopeKey: 'create-draft:club:club-1',
        idempotencyKey: 'k-1',
        semanticHash: 'hash-a',
        result: { formId: 'f-1' },
      });
      const replayed = await h.idempotency.claim({
        scopeKey: 'create-draft:club:club-1',
        idempotencyKey: 'k-1',
        semanticHash: 'hash-a',
      });
      assert.equal(replayed.inserted, false);
      assert.equal(replayed.existingHash, 'hash-a');
      const result = await h.idempotency.readResult('create-draft:club:club-1', 'k-1');
      assert.deepEqual(result, { formId: 'f-1' });
    });
  });

  it('同键异摘要：claim 暴露既有摘要（调用方判 IFC-ERR-009）', async () => {
    const h = createHarness();
    await h.uow.run({ kind: 'single', subjectId: 'leader-1' }, async () => {
      await h.idempotency.claim({
        scopeKey: 'create-draft:club:club-1',
        idempotencyKey: 'k-2',
        semanticHash: 'hash-a',
      });
      const second = await h.idempotency.claim({
        scopeKey: 'create-draft:club:club-1',
        idempotencyKey: 'k-2',
        semanticHash: 'hash-b',
      });
      assert.equal(second.inserted, false);
      assert.equal(second.existingHash, 'hash-a');
    });
  });

  it('claim 后未 complete：readResult 为 null（IFC-ERR-014 处理中）', async () => {
    const h = createHarness();
    await h.uow.run({ kind: 'single', subjectId: 'leader-1' }, async () => {
      await h.idempotency.claim({
        scopeKey: 'create-draft:club:club-1',
        idempotencyKey: 'k-3',
        semanticHash: 'hash-a',
      });
      const result = await h.idempotency.readResult('create-draft:club:club-1', 'k-3');
      assert.equal(result, null);
    });
  });

  it('release 释放占位后：同键重新 claim 为新占位（避免卡死 PROCESSING）', async () => {
    const h = createHarness();
    await h.uow.run({ kind: 'single', subjectId: 'leader-1' }, async () => {
      await h.idempotency.claim({
        scopeKey: 'create-draft:club:club-1',
        idempotencyKey: 'k-4',
        semanticHash: 'hash-a',
      });
      await h.idempotency.release('create-draft:club:club-1', 'k-4');
      const again = await h.idempotency.claim({
        scopeKey: 'create-draft:club:club-1',
        idempotencyKey: 'k-4',
        semanticHash: 'hash-b',
      });
      assert.equal(again.inserted, true);
      assert.equal(again.existingHash, null);
    });
  });
});
