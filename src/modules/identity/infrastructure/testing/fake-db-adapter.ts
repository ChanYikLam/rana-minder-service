/**
 * 内存 DbAdapter 测试替身（infrastructure spec 共用）。
 *
 * 记录事务生命周期（begin/commit/rollback/RLS 上下文）与全部查询，
 * 可按表提供行数据（load）或注入失败（failQuery/failCommit）。
 *
 * INSERT … ON CONFLICT … WHERE version = $N … RETURNING：按 PG 语义模拟——
 * 键列已存在且版本守卫不匹配 → 返回空集（0 行更新）；否则视为写入成功返回返回列。
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
    const insert = matchInsert(sql);
    if (insert) {
      return handleUpsert(this.tables, insert, sql, params) as unknown as T[];
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

interface InsertShape {
  table: string;
  columns: string[];
}

function matchInsert(sql: string): InsertShape | null {
  const match = /INSERT INTO\s+([a-z_]+)\s*\(([^)]+)\)/i.exec(sql);
  if (!match) {
    return null;
  }
  return {
    table: match[1],
    columns: match[2].split(',').map((column) => column.trim().toLowerCase()),
  };
}

function handleUpsert(
  tables: Map<string, FakeRow[]>,
  insert: InsertShape,
  sql: string,
  params: readonly unknown[],
): FakeRow[] {
  const returning = /RETURNING\s+([a-z_]+)/i.exec(sql);
  if (!returning) {
    return [];
  }
  const conflictKey = /ON CONFLICT\s*\(([a-z_,\s]+)\)/i
    .exec(sql)?.[1]
    .replace(/\s+/g, '')
    .toLowerCase();
  const guard = matchVersionGuard(sql);
  const existingRows = tables.get(insert.table) ?? [];
  if (conflictKey) {
    const keyIndex = insert.columns.indexOf(conflictKey);
    const keyValue = params[keyIndex];
    const existing = existingRows.find((row) => row[conflictKey] === keyValue);
    if (existing && guard) {
      const current = existing[guard.column];
      if (current !== params[guard.paramIndex]) {
        return [];
      }
    }
  }
  return [{ [returning[1]]: params[0] }];
}

function matchVersionGuard(sql: string): { column: string; paramIndex: number } | null {
  const where = /WHERE\s+([a-z_]+(?:\.[a-z_]+)?)\s*=\s*\$(\d+)/i.exec(sql);
  if (!where) {
    return null;
  }
  return { column: where[1].split('.').pop() as string, paramIndex: Number(where[2]) - 1 };
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
