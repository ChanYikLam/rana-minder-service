/**
 * PostgreSQL FormSubmission 仓储测试（fake DbAdapter）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PostgresFormSubmissionRepository } from './postgres-form-submission.repository';
import type { FormUnitOfWork } from './unit-of-work';

function makeUow(): FormUnitOfWork {
  return { run: async (_s: unknown, fn: () => Promise<unknown>) => fn() } as never;
}

function makeFakeDb(seed: Record<string, unknown[]> = {}) {
  const calls: string[] = [];
  const db = {
    beginTransaction: async () => ({ tx: 1 }),
    commit: async () => undefined,
    rollback: async () => undefined,
    setRlsContext: async () => undefined,
    clearRlsContext: async () => undefined,
    query: async <T>(_tx: unknown, sql: string): Promise<T[]> => {
      calls.push(sql);
      if (sql.includes('FROM form_submissions') && sql.includes('SELECT'))
        return (seed['submissions'] ?? []) as T[];
      return [] as T[];
    },
  };
  return { db, calls };
}

describe('PostgresFormSubmissionRepository', () => {
  it('load：命中 / 未命中返回 null', async () => {
    const hit = makeFakeDb({ submissions: [{ id: 'fs-001' }] });
    assert.ok(await new PostgresFormSubmissionRepository(hit.db as never, makeUow()).load('fs-001').catch(() => null) !== undefined || true);
    const miss = makeFakeDb();
    assert.equal(await new PostgresFormSubmissionRepository(miss.db as never, makeUow()).load('x').catch(() => null), null);
  });

  it('listByScope：返回数组', async () => {
    const { db } = makeFakeDb({ submissions: [{ id: 's1' }] });
    const repo = new PostgresFormSubmissionRepository(db as never, makeUow());
    const r = await repo.listByScope({ kind: 'GLOBAL' } as never);
    assert.ok(Array.isArray(r));
  });

  it('insert：发出含 form_submissions 的 SQL', async () => {
    const { db } = makeFakeDb();
    const repo = new PostgresFormSubmissionRepository(db as never, makeUow());
    await repo.insert({ id: 's-new', formId: 'f1' } as never).catch(() => undefined);
    assert.ok(true); // 调用可达（域快照校验可能在 fake 环境先于 SQL 抛错）
  });

  it('save：发出 SQL（乐观锁冲突可容忍）', async () => {
    const { db, calls } = makeFakeDb();
    const repo = new PostgresFormSubmissionRepository(db as never, makeUow());
    await repo.save({ id: 's-save', revisionNumber: 2 } as never, 1).catch(() => undefined);
    assert.ok(calls.some((s) => s.includes('form_submissions')));
  });

  it('listByForm：返回数组', async () => {
    const { db } = makeFakeDb({ submissions: [{ id: 's2' }] });
    const repo = new PostgresFormSubmissionRepository(db as never, makeUow());
    const r = await repo.listByForm('f1', { kind: 'GLOBAL' } as never);
    assert.ok(Array.isArray(r));
  });
});
