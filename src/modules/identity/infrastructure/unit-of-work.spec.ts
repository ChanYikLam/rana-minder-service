/**
 * IdentityUnitOfWork 单元测试（OPS-DB-003 §9.1 上下文生命周期）。
 *
 * 覆盖：事务内建立并验证 RLS 单目标上下文、成功提交、失败回滚、
 * 全部结束路径清理上下文、嵌套拒绝、无活动事务读写失败关闭。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityUnitOfWork } from './unit-of-work';
import { FakeDbAdapter } from './testing/fake-db-adapter';

describe('IdentityUnitOfWork（IFC-TX-001 原子提交边界）', () => {
  it('NOM：RLS 单目标上下文内执行并提交，结束路径清理', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    let activeTxId: string | null = null;

    const result = await uow.run({ kind: 'single', subjectId: 'user-1' }, async () => {
      activeTxId = uow.active.id;
      return 'done';
    });

    assert.equal(result, 'done');
    assert.ok(activeTxId !== null);
    assert.deepEqual(db.events, [
      `begin:${activeTxId}`,
      `set-rls:${activeTxId}:single`,
      `commit:${activeTxId}`,
      `clear-rls:${activeTxId}`,
    ]);
    assert.equal(db.events.includes(`rollback:${activeTxId}`), false);
  });

  it('失败 → 回滚并清理上下文，异常透传', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);

    await assert.rejects(
      uow.run({ kind: 'single', subjectId: 'user-1' }, async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    const txId = db.events[0].slice('begin:'.length);
    assert.deepEqual(db.events, [
      `begin:${txId}`,
      `set-rls:${txId}:single`,
      `rollback:${txId}`,
      `clear-rls:${txId}`,
    ]);
  });

  it('提交失败 → 回滚并清理，不残留上下文', async () => {
    const db = new FakeDbAdapter();
    db.commitError = new Error('commit failed');
    const uow = new IdentityUnitOfWork(db);

    await assert.rejects(uow.run({ kind: 'single', subjectId: 'user-1' }, async () => 1));
    const txId = db.events[0].slice('begin:'.length);
    assert.equal(db.events.includes(`rollback:${txId}`), true);
    assert.equal(db.events.includes(`clear-rls:${txId}`), true);
  });

  it('嵌套事务拒绝（工作单元不支持嵌套）', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);

    await assert.rejects(
      uow.run({ kind: 'single', subjectId: 'user-1' }, async () => {
        await uow.run({ kind: 'single', subjectId: 'user-1' }, async () => 1);
      }),
      /嵌套/,
    );
  });

  it('无活动事务访问 active → 失败关闭', () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);

    assert.throws(() => uow.active, /无活动事务/);
  });

  it('afterCommit 回调在提交成功后按序执行（外部投递不纳入原子提交）', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    const order: string[] = [];

    await uow.run({ kind: 'single', subjectId: 'user-1' }, async () => {
      uow.afterCommit(async () => {
        order.push('after-commit');
      });
    });

    // 提交成功后才执行回调
    const txId = db.events[0].slice('begin:'.length);
    assert.equal(db.events.includes(`commit:${txId}`), true);
    assert.deepEqual(order, ['after-commit']);
  });

  it('事务回滚时 afterCommit 回调不执行（不投递“死令牌”）', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    let ran = false;

    await assert.rejects(
      uow.run({ kind: 'single', subjectId: 'user-1' }, async () => {
        uow.afterCommit(async () => {
          ran = true;
        });
        throw new Error('boom');
      }),
      /boom/,
    );

    assert.equal(ran, false);
  });

  it('afterCommit 回调抛错不影响已提交结果，仅吞掉并记录', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);

    const result = await uow.run({ kind: 'single', subjectId: 'user-1' }, async () => {
      uow.afterCommit(async () => {
        throw new Error('delivery failed');
      });
      return 'ok';
    });

    assert.equal(result, 'ok');
  });
});
