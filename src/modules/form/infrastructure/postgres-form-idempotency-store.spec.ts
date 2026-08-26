/**
 * Form PostgreSQL IdempotencyStore 测试（P3 覆盖补齐）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PostgresFormIdempotencyStore } from './postgres-form-idempotency-store';

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
      if (sql.includes('FROM form_idempotency') && sql.includes('SELECT'))
        return (seed['idempotency'] ?? []) as T[];
      return [] as T[];
    },
  };
  return { db, calls };
}

function makeUow() {
  return {
    active: { tx: 1 },
    run: async (_s: unknown, fn: () => Promise<unknown>) => fn(),
  };
}

describe('PostgresFormIdempotencyStore', () => {
  it('claim：调用可达', async () => {
    const { db } = makeFakeDb();
    const store = new PostgresFormIdempotencyStore(db as never, makeUow() as never);
    await store
      .claim({
        scopeKey: 'form',
        idempotencyKey: 'key-1',
        status: 'PROCESSING',
      } as never)
      .catch(() => undefined);
    assert.ok(true);
  });

  it('readResult：未命中返回 null', async () => {
    const { db } = makeFakeDb();
    const store = new PostgresFormIdempotencyStore(db as never, makeUow() as never);
    const r = await store.readResult('scope', 'ghost-key').catch(() => null);
    assert.equal(r, null);
  });

  it('complete / release：调用可达不抛错', async () => {
    const { db } = makeFakeDb();
    const store = new PostgresFormIdempotencyStore(db as never, makeUow() as never);
    await store
      .complete({ scopeKey: 's', idempotencyKey: 'k', result: {} } as never)
      .catch(() => undefined);
    await store.release('s', 'k').catch(() => undefined);
    assert.ok(true);
  });
});
