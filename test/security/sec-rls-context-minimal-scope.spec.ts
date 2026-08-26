/**
 * 安全控制独立验证：SEC-CTL-009 / SEC-CTL-010 / SEC-CTL-011（RLS 与连接上下文守卫）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5、§8.2/§8.3。
 *
 * 验证路径（真实类 + 假适配器，无 pg 依赖）：
 * - src/shared/db-adapter.ts（RlsScope 最小上下文契约）
 * - src/modules/identity/infrastructure/unit-of-work.ts（事务内建立/清理上下文）
 * - src/adapters/db/not-wired-db.adapter.ts（未接线全拒 fail-closed）
 * - test/ops/helpers/recording-db.ts（SQL 记录假体）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { RlsScope, TransactionContext } from '../../src/shared/db-adapter';
import { NotWiredDbAdapter, DbUnavailableError } from '../../src/adapters/db/not-wired-db.adapter';
import { IdentityUnitOfWork } from '../../src/modules/identity/infrastructure/unit-of-work';
import { PostgresSessionRevocation } from '../../src/modules/identity/infrastructure/postgres-session-revocation';

/** 记录 setRlsContext 收到的完整 scope 对象（验证最小上下文内容）。 */
class ScopeRecordingDb {
  readonly scopes: RlsScope[] = [];
  readonly events: string[] = [];
  async beginTransaction(): Promise<TransactionContext> {
    this.events.push('begin');
    return { id: 'tx-1' };
  }
  async commit(): Promise<void> {
    this.events.push('commit');
  }
  async rollback(): Promise<void> {
    this.events.push('rollback');
  }
  async setRlsContext(_tx: TransactionContext, scope: RlsScope): Promise<void> {
    this.scopes.push(scope);
    this.events.push('set-rls');
  }
  async clearRlsContext(): Promise<void> {
    this.events.push('clear-rls');
  }
  async query<T>(): Promise<T[]> {
    return [] as T[];
  }
}

function makeDb(): ScopeRecordingDb {
  return new ScopeRecordingDb();
}

describe('SEC-CTL-009 数据库最小作用域上下文（应用授权与结构性隔离分工）', () => {
  it('SEC-CTL-009：单目标读写上下文恰好携带一个目标主体（kind=single + subjectId）', async () => {
    const db = makeDb();
    const uow = new IdentityUnitOfWork(db);
    await uow.run({ kind: 'single', subjectId: 'u-42' }, async () => undefined);

    assert.deepEqual(db.scopes, [{ kind: 'single', subjectId: 'u-42' }]);
    assert.equal(db.events.filter((e) => e === 'set-rls').length, 1, '每事务仅建立一次上下文');
  });

  it('SEC-CTL-009：集合只读与免保护上下文按用途分别传递，不得互相冒充', async () => {
    const db = makeDb();
    const uow = new IdentityUnitOfWork(db);
    const collection: RlsScope = { kind: 'collection-readonly', scopeKey: 'frozen-set-1' };
    await uow.run(collection, async () => undefined);
    await uow.run({ kind: 'unprotected' }, async () => undefined);

    assert.deepEqual(db.scopes, [
      { kind: 'collection-readonly', scopeKey: 'frozen-set-1' },
      { kind: 'unprotected' },
    ]);
    assert.ok(!db.scopes.some((s) => s.kind === 'single'), '集合只读路径不得携带单目标写上下文');
  });
});

describe('SEC-CTL-010 上下文只在事务内存续并在全部结束路径清理', () => {
  it('SEC-CTL-010：成功提交后上下文清理，工作单元无残留活动事务', async () => {
    const db = makeDb();
    const uow = new IdentityUnitOfWork(db);
    await uow.run({ kind: 'single', subjectId: 'u1' }, async () => 'ok');
    assert.deepEqual(db.events, ['begin', 'set-rls', 'commit', 'clear-rls']);
    assert.throws(() => uow.active, /无活动事务/);
  });

  it('SEC-CTL-010：业务异常回滚后仍兜底清理，绝不以 commit 收口', async () => {
    const db = makeDb();
    const uow = new IdentityUnitOfWork(db);
    await assert.rejects(
      uow.run({ kind: 'single', subjectId: 'u1' }, async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.deepEqual(db.events, ['begin', 'set-rls', 'rollback', 'clear-rls']);
  });

  it('SEC-CTL-010：嵌套 run 被立即拒绝（防上下文覆盖/污染）', async () => {
    const db = makeDb();
    const uow = new IdentityUnitOfWork(db);
    await assert.rejects(
      uow.run({ kind: 'single', subjectId: 'u1' }, () =>
        uow.run({ kind: 'single', subjectId: 'u2' }, async () => undefined),
      ),
      /不支持嵌套事务/,
    );
    // 嵌套请求从未获得自己的上下文：仅外层建立过一次 set-rls
    assert.equal(db.scopes.length, 1);
    assert.deepEqual(db.scopes[0], { kind: 'single', subjectId: 'u1' });
    assert.equal(db.events[db.events.length - 1], 'clear-rls', '外层随后仍完整收口');
  });
});

describe('SEC-CTL-011 未接线/脱离事务路径失败关闭', () => {
  it('SEC-CTL-011：NotWiredDbAdapter 全部操作抛 DbUnavailableError，不静默成功', async () => {
    const adapter = new NotWiredDbAdapter();
    await assert.rejects(adapter.beginTransaction(), DbUnavailableError);
    const tx = { id: 'x' } as TransactionContext;
    await assert.rejects(adapter.commit(tx), DbUnavailableError);
    await assert.rejects(adapter.rollback(tx), DbUnavailableError);
    await assert.rejects(adapter.setRlsContext(tx, { kind: 'unprotected' }), DbUnavailableError);
    await assert.rejects(adapter.clearRlsContext(tx), DbUnavailableError);
    await assert.rejects(adapter.query(tx, 'SELECT 1', []), DbUnavailableError);
  });

  it('SEC-CTL-011：会话吊销等受保护操作脱离事务边界即被拒（禁止绕过上下文直连）', async () => {
    class NoopDb extends NotWiredDbAdapter {}
    const db = new NoopDb();
    const revocation = new PostgresSessionRevocation(db, new IdentityUnitOfWork(db));
    await assert.rejects(revocation.invalidateAllSessions('u1'), /无活动事务/);
  });
});
