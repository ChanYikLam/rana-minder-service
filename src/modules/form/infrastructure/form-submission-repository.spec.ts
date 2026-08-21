/**
 * form 提交 PostgreSQL 仓储测试（FakeDbAdapter 全链路；FORM-002）。
 *
 * 覆盖：insert/load 往返、loadBySubmitter、listByScope、修订号乐观守卫
 * （0 行冲突）、id 冲突。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDbAdapter } from '../../../shared/testing/fake-db-adapter';
import { FormUnitOfWork } from './unit-of-work';
import { PostgresFormSubmissionRepository } from './postgres-form-submission.repository';
import { FormSubmission } from '../domain/models/form-submission';
import { DefaultFormSubmissionStateMachine } from '../domain/state-machines/form-submission.state-machine';

const CLUB = { kind: 'club', ownerId: 'club-1' } as const;
const NOW = new Date('2026-08-21T08:00:00.000Z');

function createSubmission(id: string) {
  const sub = FormSubmission.createDraft({
    id,
    formId: 'f-1',
    versionNumber: 1,
    scope: CLUB,
    submittedBy: 'u-1',
    values: { name: '张三' },
    now: NOW,
  });
  sub.submit(new DefaultFormSubmissionStateMachine(), NOW);
  return sub.toSnapshot();
}

function createHarness() {
  const db = new FakeDbAdapter();
  const uow = new FormUnitOfWork(db);
  const repository = new PostgresFormSubmissionRepository(db, uow);
  return { db, uow, repository };
}

describe('PostgresFormSubmissionRepository（FakeDbAdapter 全链路）', () => {
  it('insert → load 往返：JSONB 值解析回对象', async () => {
    const h = createHarness();
    await h.uow.run({ kind: 'single', subjectId: 'u-1' }, async () => {
      await h.repository.insert(createSubmission('s-1'));
      const loaded = await h.repository.load('s-1');
      assert.equal(loaded?.submittedBy, 'u-1');
      assert.equal(loaded?.status, 'SUBMITTED');
      assert.deepEqual(loaded?.values, { name: '张三' });
      assert.equal(loaded?.revisionNumber, 1);
    });
  });

  it('loadBySubmitter：同一提交者版本定位', async () => {
    const h = createHarness();
    await h.uow.run({ kind: 'single', subjectId: 'u-1' }, async () => {
      await h.repository.insert(createSubmission('s-1'));
      const found = await h.repository.loadBySubmitter('f-1', 1, 'u-1');
      assert.equal(found?.id, 's-1');
      const none = await h.repository.loadBySubmitter('f-1', 1, 'other');
      assert.equal(none, null);
    });
  });

  it('listByScope：按作用域过滤', async () => {
    const h = createHarness();
    await h.uow.run({ kind: 'single', subjectId: 'u-1' }, async () => {
      await h.repository.insert(createSubmission('s-1'));
      const list = await h.repository.listByScope(CLUB);
      assert.equal(list.length, 1);
      const empty = await h.repository.listByScope({ kind: 'club', ownerId: 'club-2' });
      assert.equal(empty.length, 0);
    });
  });

  it('listByForm：按表单+作用域过滤（跨 owner 不外泄）', async () => {
    const h = createHarness();
    await h.uow.run({ kind: 'single', subjectId: 'u-1' }, async () => {
      await h.repository.insert(createSubmission('s-1'));
      const club = await h.repository.listByForm('f-1', CLUB);
      assert.equal(club.length, 1);
      assert.equal(club[0].id, 's-1');
      const other = await h.repository.listByForm('f-1', {
        kind: 'club',
        ownerId: 'club-2',
      });
      assert.equal(other.length, 0);
    });
  });

  it('修订号乐观守卫：期望修订不匹配 → 0 行冲突', async () => {
    const h = createHarness();
    await h.uow.run({ kind: 'single', subjectId: 'u-1' }, async () => {
      const snapshot = createSubmission('s-1');
      await h.repository.insert(snapshot);
      const revised = { ...snapshot, values: { name: '张三丰' }, revisionNumber: 2 };
      await assert.rejects(h.repository.save(revised, 5), /提交已被他人修订，请刷新后重试/);
      await h.repository.save(revised, 1);
      const loaded = await h.repository.load('s-1');
      assert.equal(loaded?.revisionNumber, 2);
      assert.deepEqual(loaded?.values, { name: '张三丰' });
    });
  });

  it('id 冲突：insert 重复 → 拒绝', async () => {
    const h = createHarness();
    await h.uow.run({ kind: 'single', subjectId: 'u-1' }, async () => {
      await h.repository.insert(createSubmission('s-1'));
      await assert.rejects(
        h.repository.insert(createSubmission('s-1')),
        /提交记录已存在，请勿重复提交/,
      );
    });
  });
});
