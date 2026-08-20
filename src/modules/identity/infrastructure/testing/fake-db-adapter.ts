/**
 * 内存 DbAdapter 测试替身（infrastructure spec 共用）。
 *
 * 记录事务生命周期（begin/commit/rollback/RLS 上下文）与全部查询，
 * 可按表提供行数据（load）或注入失败（failQuery/failCommit）。
 */

import type { DbAdapter, RlsScope, TransactionContext } from '../../../../shared/db-adapter';

export interface FakeRow {
  [column: string]: unknown;
}

export class FakeDbAdapter implements DbAdapter {
  readonly events: string[] = [];
  readonly queries: { sql: string; params: readonly unknown[] }[] = [];
  private readonly tables = new Map<string, FakeRow[]>();
  commitError: Error | null = null;
  queryError: Error | null = null;

  seed(table: string, rows: FakeRow[]): void {
    this.tables.set(table, rows);
  }

  async beginTransaction(): Promise<TransactionContext> {
    const tx = { id: `tx-${this.events.length + 1}` };
    this.events.push(`begin:${tx.id}`);
    return tx;
  }

  async commit(tx: TransactionContext): Promise<void> {
    this.events.push(`commit:${tx.id}`);
    if (this.commitError) {
      throw this.commitError;
    }
  }

  async rollback(tx: TransactionContext): Promise<void> {
    this.events.push(`rollback:${tx.id}`);
  }

  async setRlsContext(tx: TransactionContext, scope: RlsScope): Promise<void> {
    this.events.push(`set-rls:${tx.id}:${scope.kind}`);
  }

  async clearRlsContext(tx: TransactionContext): Promise<void> {
    this.events.push(`clear-rls:${tx.id}`);
  }

  async query<T>(tx: TransactionContext, sql: string, params: readonly unknown[]): Promise<T[]> {
    this.events.push(`query:${tx.id}`);
    this.queries.push({ sql, params });
    if (this.queryError) {
      throw this.queryError;
    }
    const table = matchTable(sql);
    if (!table) {
      return [];
    }
    let rows = this.tables.get(table) ?? [];
    const conditions = matchWhere(sql);
    for (const [column, index] of conditions) {
      const value = params[index];
      rows = rows.filter((row) => row[column] === value);
    }
    return rows as unknown as T[];
  }
}

function matchTable(sql: string): string | null {
  const match = /FROM\s+([a-z_]+)/i.exec(sql);
  return match ? match[1] : null;
}

function matchWhere(sql: string): Array<[string, number]> {
  const conditions: Array<[string, number]> = [];
  const where = /WHERE\s+(.+)/i.exec(sql);
  if (!where) {
    return conditions;
  }
  const pattern = /([a-z_]+)\s*=\s*\$(\d+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(where[1])) !== null) {
    conditions.push([match[1], Number(match[2]) - 1]);
  }
  return conditions;
}