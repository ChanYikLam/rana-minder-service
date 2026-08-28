/**
 * PostgresOidcNonceStore 单元测试（B3 修复：共享存储语义）。
 *
 * 用最小 DbAdapter 桩精确模拟本实现使用的两条语句（INSERT upsert 与
 * UPDATE ... WHERE consumed_at IS NULL ... RETURNING 的原子单胜者语义），
 * 校验：落库参数、一次性消费、载荷取回、失败回滚与错误透传。
 * （FakeDbAdapter 的通用 RETURNING 模拟对本语句过粗，故用专用桩。）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PostgresOidcNonceStore } from './postgres-oidc-nonce.store';
import type { DbAdapter, RlsScope, TransactionContext } from '../../../shared/db-adapter';

interface NonceTableRow {
  nonce: string;
  payload: string;
  expires_at: number; // epoch ms
  consumed_at: number | null;
}

/** 针对 oidc_nonce_issues 两条语句的精确语义桩 */
class NonceTableDb implements DbAdapter {
  readonly events: string[] = [];
  readonly queries: { sql: string; params: readonly unknown[] }[] = [];
  rows: NonceTableRow[] = [];
  failOnSql: RegExp | null = null;
  private txSeq = 0;

  async beginTransaction(): Promise<TransactionContext> {
    const tx = { id: `tx-${++this.txSeq}` };
    this.events.push(`begin:${tx.id}`);
    return tx;
  }
  async commit(tx: TransactionContext): Promise<void> {
    this.events.push(`commit:${tx.id}`);
  }
  async rollback(tx: TransactionContext): Promise<void> {
    this.events.push(`rollback:${tx.id}`);
  }
  async setRlsContext(tx: TransactionContext, scope: RlsScope): Promise<void> {
    this.events.push(`rls:${tx.id}:${scope.kind}`);
  }
  async clearRlsContext(tx: TransactionContext): Promise<void> {
    this.events.push(`clear-rls:${tx.id}`);
  }
  async query<T>(tx: TransactionContext, sql: string, params: readonly unknown[]): Promise<T[]> {
    this.events.push(`query:${tx.id}`);
    this.queries.push({ sql, params });
    if (this.failOnSql && this.failOnSql.test(sql)) {
      throw new Error('db down (injected)');
    }
    if (/INSERT INTO\s+oidc_nonce_issues/i.test(sql)) {
      const [nonce, payload, secs] = params as [string, string, number];
      const exists = this.rows.find((r) => r.nonce === nonce);
      if (!exists) {
        this.rows.push({
          nonce,
          payload,
          expires_at: Date.now() + secs * 1000,
          consumed_at: null,
        });
      }
      return [] as unknown as T[];
    }
    if (/UPDATE\s+oidc_nonce_issues/i.test(sql)) {
      // 原子单胜者：仅"未消费且未过期"的行可被置 consumed，并 RETURNING payload
      const [nonce] = params as [string];
      const row = this.rows.find(
        (r) => r.nonce === nonce && r.consumed_at === null && r.expires_at > Date.now(),
      );
      if (!row) return [] as unknown as T[];
      row.consumed_at = Date.now();
      return [{ payload: row.payload }] as unknown as T[];
    }
    if (/DELETE FROM\s+oidc_nonce_issues/i.test(sql)) {
      this.rows = this.rows.filter((r) => r.expires_at > Date.now() - 24 * 60 * 60 * 1000);
      return [] as unknown as T[];
    }
    return [] as unknown as T[];
  }
}

function makeStore() {
  const db = new NonceTableDb();
  return { db, store: new PostgresOidcNonceStore(db) };
}

describe('PostgresOidcNonceStore（B3：共享存储 nonce/PKCE 载荷）', () => {
  it('issue 落库：nonce + 载荷 + TTL，事务提交（unprotected 直连）', async () => {
    const { db, store } = makeStore();
    await store.issue('nonce-1', 600_000, 'verifier-1');
    const insert = db.queries.find((q) => /INSERT INTO\s+oidc_nonce_issues/i.test(q.sql));
    assert.ok(insert, '应执行 INSERT');
    assert.deepEqual(insert.params.slice(0, 2), ['nonce-1', 'verifier-1']);
    assert.ok(db.events.includes('rls:tx-1:unprotected'), '登录前流程使用 unprotected 上下文');
    assert.ok(db.events.includes('commit:tx-1'), '成功路径必须提交');
  });

  it('consume：签发过的 nonce 一次性取回载荷', async () => {
    const { store } = makeStore();
    await store.issue('nonce-2', 600_000, 'verifier-2');
    assert.equal(await store.consume('nonce-2'), 'verifier-2');
    assert.equal(await store.consume('nonce-2'), null, '原子单胜者：二次消费拒绝');
  });

  it('consume：未签发/已消费/已过期 → null（fail-closed）', async () => {
    const { store } = makeStore();
    assert.equal(await store.consume('never-issued'), null);
    await store.issue('nonce-3', -1, 'stale');
    assert.equal(await store.consume('nonce-3'), null, '过期 nonce 拒绝');
  });

  it('载荷为空串的 nonce（未启用 PKCE）消费返回空串而非 null', async () => {
    const { store } = makeStore();
    await store.issue('nonce-4');
    assert.equal(await store.consume('nonce-4'), '');
  });

  it('DB 故障：issue/consume 回滚并把错误透传（不静默吞掉）', async () => {
    const { db, store } = makeStore();
    db.failOnSql = /INSERT INTO\s+oidc_nonce_issues/i;
    await assert.rejects(store.issue('nonce-err'), /db down/);
    assert.ok(db.events.includes('rollback:tx-1'), '失败路径必须回滚');

    db.failOnSql = /UPDATE\s+oidc_nonce_issues/i;
    await assert.rejects(store.consume('nonce-err2'), /db down/);
  });

  it('consume 为原子 UPDATE ... RETURNING：消费与载荷取回同语句完成', async () => {
    const { db, store } = makeStore();
    await store.issue('nonce-5', 600_000, 'verifier-5');
    db.queries.length = 0;
    await store.consume('nonce-5');
    const update = db.queries.find((q) => /UPDATE\s+oidc_nonce_issues/i.test(q.sql));
    assert.ok(update, '应执行 UPDATE');
    assert.match(update.sql, /consumed_at IS NULL/, '单胜者守卫必须存在');
    assert.match(update.sql, /RETURNING\s+payload/, '载荷经 RETURNING 同语句取回');
  });
});
