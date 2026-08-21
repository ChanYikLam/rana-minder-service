/**
 * 内存 DbAdapter 测试替身（infrastructure spec 共用）。
 *
 * 记录事务生命周期（begin/commit/rollback/RLS 上下文）与全部查询，
 * 可按表提供行数据（seed）或注入失败（failQuery/failCommit）。
 *
 * SQL 模拟语义（PG 对齐）：
 * - INSERT … ON CONFLICT(键) DO UPDATE … WHERE guard=$N … RETURNING：
 *   键列已存在且守卫不匹配 → 空集（0 行更新）；否则写入成功返回返回列；
 * - INSERT … ON CONFLICT DO NOTHING（无 DO UPDATE）：键已存在 → 空集；
 * - UPDATE … SET … WHERE guard=$N … RETURNING：守卫不匹配 → 空集；
 * - WHERE 支持 `col = $N` 与 `col IS NOT DISTINCT FROM $N`（NULL 相等）；
 * - ORDER BY col ASC|DESC 与 LIMIT N 对过滤结果排序/截断。
 */

import type { DbAdapter, RlsScope, TransactionContext } from '../db-adapter';

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
    const update = matchUpdate(sql);
    if (update) {
      return handleUpdate(this.tables, update, sql, params) as unknown as T[];
    }
    const table = matchTable(sql);
    if (!table) {
      return [];
    }
    let rows = this.tables.get(table) ?? [];
    const conditions = matchWhere(sql);
    for (const [column, index, distinct] of conditions) {
      const value = params[index];
      rows = rows.filter((row) =>
        distinct
          ? (row[column] === null && value === null) || row[column] === value
          : row[column] === value,
      );
    }
    const orderBy = matchOrderBy(sql);
    if (orderBy) {
      const { column, direction } = orderBy;
      rows = [...rows].sort((a, b) => {
        const left = Number(a[column]) || (a[column] as string);
        const right = Number(b[column]) || (b[column] as string);
        const compare = left < right ? -1 : left > right ? 1 : 0;
        return direction === 'DESC' ? -compare : compare;
      });
    }
    const limit = matchLimit(sql);
    if (limit !== null) {
      rows = rows.slice(0, limit);
    }
    return rows as unknown as T[];
  }
}

interface InsertShape {
  table: string;
  columns: string[];
}

interface UpdateShape {
  table: string;
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

function matchUpdate(sql: string): UpdateShape | null {
  const match = /^\s*UPDATE\s+([a-z_]+)\s+SET/i.exec(sql);
  if (!match) {
    return null;
  }
  return { table: match[1] };
}

function handleUpsert(
  tables: Map<string, FakeRow[]>,
  insert: InsertShape,
  sql: string,
  params: readonly unknown[],
): FakeRow[] {
  const returning = /RETURNING\s+([a-z_]+)/i.exec(sql);
  const conflictKeys = matchConflictKeys(sql);
  const guard = matchVersionGuard(sql);
  const doNothing = /ON CONFLICT[^)]*\)\s*DO NOTHING/i.test(sql);
  const existingRows = tables.get(insert.table) ?? [];
  const existing =
    conflictKeys.length > 0
      ? existingRows.find((row) =>
          conflictKeys.every((key) => {
            const index = insert.columns.indexOf(key);
            return index >= 0 && row[key] === params[index];
          }),
        )
      : undefined;
  if (existing) {
    if (doNothing) {
      return [];
    }
    if (guard) {
      const current = existing[guard.column];
      if (current !== params[guard.paramIndex]) {
        return [];
      }
    }
    for (let index = 0; index < insert.columns.length; index += 1) {
      existing[insert.columns[index]] = coerceJson(params[index]);
    }
    return returning ? [{ [returning[1]]: params[0] }] : [];
  }
  const row: FakeRow = {};
  insert.columns.forEach((column, index) => {
    row[column] = coerceJson(params[index]);
  });
  existingRows.push(row);
  tables.set(insert.table, existingRows);
  return returning ? [{ [returning[1]]: params[0] }] : [];
}

function handleUpdate(
  tables: Map<string, FakeRow[]>,
  update: UpdateShape,
  sql: string,
  params: readonly unknown[],
): FakeRow[] {
  const returning = /RETURNING\s+([a-z_]+)/i.exec(sql);
  const conditions = matchWhere(sql);
  const rows = tables.get(update.table) ?? [];
  const target = rows.find((row) =>
    conditions.every(([column, index, distinct]) =>
      distinct
        ? (row[column] === null && params[index] === null) || row[column] === params[index]
        : row[column] === params[index],
    ),
  );
  if (!target) {
    return [];
  }
  const assignments = matchAssignments(sql);
  for (const [column, paramIndex, increment] of assignments) {
    if (increment) {
      target[column] = Number(target[column]) + increment;
    } else {
      target[column] = coerceJson(params[paramIndex]);
    }
  }
  return returning ? [{ [returning[1]]: params[0] }] : [];
}

function matchAssignments(sql: string): Array<[string, number, number]> {
  const assignments: Array<[string, number, number]> = [];
  const set = /SET\s+(.+?)(?:WHERE|RETURNING)/is.exec(sql);
  if (!set) {
    return assignments;
  }
  const pattern = /([a-z_]+)\s*=\s*(?:\$(\d+)|\1\s*\+\s*(\d+))/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(set[1])) !== null) {
    const column = match[1];
    if (match[2] !== undefined) {
      assignments.push([column, Number(match[2]) - 1, 0]);
    } else if (match[3] !== undefined) {
      assignments.push([column, -1, Number(match[3])]);
    }
  }
  return assignments;
}

/** jsonb 参数以 JSON 字符串写入，回读前解析为对象（普通字符串原样保留） */
function coerceJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  if (value.startsWith('[') || value.startsWith('{')) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function matchConflictKeys(sql: string): string[] {
  const match = /ON CONFLICT\s*\(([^)]+)\)/i.exec(sql);
  if (!match) {
    return [];
  }
  return match[1]
    .split(',')
    .map((key) => key.trim().toLowerCase())
    .filter((key) => key.length > 0);
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

function matchWhere(sql: string): Array<[string, number, boolean]> {
  const conditions: Array<[string, number, boolean]> = [];
  const where = /WHERE\s+(.+)/i.exec(sql);
  if (!where) {
    return conditions;
  }
  const equality = /([a-z_]+)\s*=\s*\$(\d+)/gi;
  let match: RegExpExecArray | null;
  while ((match = equality.exec(where[1])) !== null) {
    conditions.push([match[1], Number(match[2]) - 1, false]);
  }
  const distinct = /([a-z_]+)\s+IS NOT DISTINCT FROM\s+\$(\d+)/gi;
  while ((match = distinct.exec(where[1])) !== null) {
    conditions.push([match[1], Number(match[2]) - 1, true]);
  }
  return conditions;
}

function matchOrderBy(sql: string): { column: string; direction: 'ASC' | 'DESC' } | null {
  const match = /ORDER BY\s+([a-z_]+)\s+(ASC|DESC)/i.exec(sql);
  if (!match) {
    return null;
  }
  return { column: match[1], direction: match[2].toUpperCase() as 'ASC' | 'DESC' };
}

function matchLimit(sql: string): number | null {
  const match = /LIMIT\s+(\d+)/i.exec(sql);
  return match ? Number(match[1]) : null;
}
