/**
 * PostgresProfileFieldDirectory 单测（4.1 字段目录配置化）。
 *
 * 覆盖：行→目录项映射（enabled 过滤在 SQL 层，fake 断言 SQL 形状）；
 * 空目录兜底内置 6 字段；表不可用（query 抛错）兜底不失效（FORM-004）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PostgresProfileFieldDirectory } from './postgres-profile-field-directory';

function makeContext(
  rows: Array<{
    field_id: string;
    label: string;
    read_only: boolean;
    editable: boolean;
  }>,
  fail = false,
) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const txCalls: string[] = [];
  const db = {
    beginTransaction: async () => {
      txCalls.push('begin');
      return { tx: 1 };
    },
    commit: async () => {
      txCalls.push('commit');
    },
    rollback: async () => {
      txCalls.push('rollback');
    },
    setRlsContext: async (_tx: unknown, scope: { kind: string }) => {
      txCalls.push(`rls:${scope.kind}`);
    },
    clearRlsContext: async () => {
      txCalls.push('clear');
    },
    query: async <T>(_tx: unknown, sql: string, params: readonly unknown[]): Promise<T[]> => {
      calls.push({ sql, params });
      if (fail) throw new Error('db-unavailable');
      return rows as T[];
    },
  };
  return { directory: new PostgresProfileFieldDirectory(db as never), calls, txCalls };
}

describe('PostgresProfileFieldDirectory（4.1 配置化目录）', () => {
  it('listApproved：启用目录按配置排序返回', async () => {
    const { directory, calls } = makeContext([
      { field_id: 'email', label: '邮箱', read_only: false, editable: true },
      { field_id: 'studentId', label: '学号', read_only: true, editable: false },
    ]);
    const entries = await directory.listApproved();
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
      fieldId: 'email',
      label: '邮箱',
      readOnly: false,
      editable: true,
    });
    assert.deepEqual(entries[1], {
      fieldId: 'studentId',
      label: '学号',
      readOnly: true,
      editable: false,
    });
    const sql = calls[0]!.sql;
    assert.match(sql, /WHERE enabled = true/);
    assert.match(sql, /ORDER BY sort_order ASC/);
  });

  it('listApproved：空目录兜底内置 6 字段（自动带入白名单不失效，FORM-004）', async () => {
    const { directory } = makeContext([]);
    const entries = await directory.listApproved();
    assert.equal(entries.length, 6);
    assert.equal(entries[0]!.fieldId, 'email');
    assert.equal(entries[4]!.fieldId, 'studentId');
    assert.equal(entries[4]!.readOnly, true);
  });

  it('listApproved：表不可用（迁移未执行）兜底内置目录，不抛错', async () => {
    const { directory } = makeContext([], true);
    const entries = await directory.listApproved();
    assert.equal(entries.length, 6);
  });

  it('listApproved：自建独立事务（不依赖调用方事务上下文，评审 Critical 防回归）', async () => {
    const { directory, txCalls } = makeContext([
      { field_id: 'email', label: '邮箱', read_only: false, editable: true },
    ]);
    await directory.listApproved();
    assert.deepEqual(txCalls, ['begin', 'rls:unprotected', 'commit', 'clear']);
  });
});
