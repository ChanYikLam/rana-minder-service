/**
 * 文件域工作单元逐行为测试（IFC-TX-001 文件侧原子提交边界；CI 阶段 4b 门禁补测）。
 *
 * 覆盖（与 RecruitmentUnitOfWork/FormUnitOfWork 同构语义）：
 * - 正常 run：begin → setRls(unprotected) → 业务回调 → commit → clearRls，
 *   回调结果透传，事务结束后无残留活动事务；
 * - 异常回滚：业务回调抛错 → rollback 收口 + 原异常上抛，绝不 commit；
 * - fail-closed：无活动事务时访问 active 抛错（禁止脱离事务读写）；
 * - 嵌套禁止：外层 run 未收口时再次 run 抛错，且外层走 rollback 收口；
 * - finally 清理：任一结果路径后 current 复位，可立即开始下一个独立事务。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FakeDbAdapter } from '../../../shared/testing/fake-db-adapter';
import type { RlsScope } from '../../../shared/db-adapter';
import { FileUnitOfWork } from './file-unit-of-work';

const SCOPE: RlsScope = { kind: 'unprotected' };

describe('FileUnitOfWork（文件域原子提交边界）', () => {
  it('正常 run：begin/setRls/commit/clearRls 全链路，回调结果透传', async () => {
    const db = new FakeDbAdapter();
    const uow = new FileUnitOfWork(db);
    const result = await uow.run(SCOPE, async () => {
      // 事务内 active 可用（返回当前事务上下文）
      assert.ok(uow.active);
      return 'ok';
    });
    assert.equal(result, 'ok');
    // 生命周期顺序：begin → set-rls → … → commit → clear-rls
    assert.deepEqual(
      db.events.filter((e) => !e.startsWith('query')),
      ['begin:tx-1', `set-rls:tx-1:${SCOPE.kind}`, 'commit:tx-1', `clear-rls:tx-1`],
    );
    assert.equal(db.events.some((e) => e.startsWith('rollback')), false);
    // 事务结束后无残留活动事务（fail-closed）
    assert.throws(() => uow.active, /无活动事务/);
  });

  it('异常回滚：回调抛错 → rollback 收口 + 原异常上抛，绝不 commit', async () => {
    const db = new FakeDbAdapter();
    const uow = new FileUnitOfWork(db);
    await assert.rejects(
      () =>
        uow.run(SCOPE, async () => {
          throw new Error('business fact failed');
        }),
      /business fact failed/,
    );
    assert.ok(db.events.some((e) => e.startsWith('begin:')));
    assert.ok(db.events.some((e) => e.startsWith(`set-rls:`)));
    assert.ok(db.events.some((e) => e.startsWith('rollback:')));
    assert.equal(db.events.some((e) => e.startsWith('commit:')), false, '失败路径不得 commit');
    // finally 清理：current 复位后可立刻开始下一个独立事务
    const second = await uow.run(SCOPE, async () => 'recovered');
    assert.equal(second, 'recovered');
    assert.ok(db.events.some((e) => e.startsWith('commit:')));
  });

  it('fail-closed：无活动事务时访问 active 抛错（禁止脱离事务读写）', () => {
    const db = new FakeDbAdapter();
    const orphan = new FileUnitOfWork(db);
    assert.throws(() => orphan.active, /无活动事务/);
  });

  it('嵌套禁止：外层未收口时内层 run 抛错；外层 rollback 收口且不产生 commit', async () => {
    const db = new FakeDbAdapter();
    const uow = new FileUnitOfWork(db);
    await assert.rejects(
      () =>
        uow.run(SCOPE, async () => {
          // 外层尚未收口时尝试嵌套开启第二个事务
          await uow.run(SCOPE, async () => 'nested');
          return 'outer';
        }),
      /不支持嵌套事务/,
    );
    // 外层异常经 rollback 收口；嵌套调用从未 begin 过第二个事务
    assert.equal(
      db.events.filter((e) => e.startsWith('begin:')).length,
      1,
      '嵌套调用不得开启第二个事务',
    );
    assert.ok(db.events.some((e) => e.startsWith('rollback:')));
    assert.equal(db.events.some((e) => e.startsWith('commit:')), false);

    // 收口复位后可重新正常使用
    const ok = await uow.run(SCOPE, async () => 'after-nested');
    assert.equal(ok, 'after-nested');
  });

  it('setRlsContext 收到声明的 RLS scope（unprotected）', async () => {
    const db = new FakeDbAdapter();
    const uow = new FileUnitOfWork(db);
    await uow.run({ kind: 'single', subjectId: 'u1' } as RlsScope, async () => undefined);
    assert.ok(
      db.events.some((e) => e === 'set-rls:tx-1:single'),
      'RLS 上下文应按声明 scope 建立',
    );
  });
});
