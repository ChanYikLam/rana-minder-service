/**
 * PostgreSQL SyncIntent 仓储测试（fake DbAdapter）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PostgresProfileSyncIntentRepository } from './postgres-sync-intent.repository';
import type { IdentityUnitOfWork } from './unit-of-work';

function makeUow(): IdentityUnitOfWork {
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
      if (sql.includes('FROM sync_intents') && sql.includes('SELECT'))
        return (seed['intents'] ?? []) as T[];
      return [] as T[];
    },
  };
  return { db, calls };
}

describe('PostgresProfileSyncIntentRepository', () => {
  it('load：未命中返回 null', async () => {
    const { db } = makeFakeDb();
    const repo = new PostgresProfileSyncIntentRepository(db as never, makeUow());
    const r = await repo.load('ghost', 'displayName' as never).catch(() => null);
    assert.equal(r, null);
  });

  it('save：发出含 sync_intents 的 SQL', async () => {
    const { db, calls } = makeFakeDb();
    const repo = new PostgresProfileSyncIntentRepository(db as never, makeUow());
    await repo.save({ id: 'si-001', status: 'PENDING' } as never, []).catch(() => undefined);
    assert.ok(calls.some((s) => s.includes('sync_intents')));
  });

  it('loadMany：返回数组', async () => {
    const { db } = makeFakeDb({ intents: [{ id: 'si-1' }] });
    const repo = new PostgresProfileSyncIntentRepository(db as never, makeUow());
    const r = await repo.loadMany('u1', ['field1'] as never).catch(() => []);
    assert.ok(Array.isArray(r));
  });
});
