/**
 * Form PostgreSQL IdempotencyStore 测试（P3 覆盖补齐）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PostgresFormIdempotencyStore } from './postgres-form-idempotency-store';

function makeFakeDb(
  seed: Record<string, unknown[]> = {},
  opts: { insertReturnsRow?: boolean } = {},
) {
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
      if (sql.includes('INSERT INTO form_idempotency') && opts.insertReturnsRow)
        return [{ scope_key: 'x' }] as T[];
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
  it('claim：新占位返回 inserted=true', async () => {
    const { db } = makeFakeDb({}, { insertReturnsRow: true });
    const store = new PostgresFormIdempotencyStore(db as never, makeUow() as never);
    const out = await store.claim({
      scopeKey: 'form',
      idempotencyKey: 'key-1',
      semanticHash: 'hash-1',
    });
    assert.equal(out.inserted, true);
    assert.equal(out.existingHash, null);
  });

  it('claim：命中既有记录返回 inserted=false 及既有摘要', async () => {
    const { db } = makeFakeDb({
      idempotency: [
        {
          scope_key: 'form',
          idempotency_key: 'key-1',
          semantic_hash: 'hash-existing',
          result: { ok: true },
        },
      ],
    });
    const store = new PostgresFormIdempotencyStore(db as never, makeUow() as never);
    const out = await store.claim({
      scopeKey: 'form',
      idempotencyKey: 'key-1',
      semanticHash: 'hash-new',
    });
    assert.equal(out.inserted, false);
    assert.equal(out.existingHash, 'hash-existing');
  });

  it('readResult：未命中返回 null', async () => {
    const { db } = makeFakeDb();
    const store = new PostgresFormIdempotencyStore(db as never, makeUow() as never);
    const r = await store.readResult('scope', 'ghost-key').catch(() => null);
    assert.equal(r, null);
  });

  it('readResult：命中回填结果返回该结果', async () => {
    const { db } = makeFakeDb({
      idempotency: [
        {
          scope_key: 's',
          idempotency_key: 'k',
          semantic_hash: 'hash-x',
          result: { ok: true },
        },
      ],
    });
    const store = new PostgresFormIdempotencyStore(db as never, makeUow() as never);
    const r = await store.readResult('s', 'k');
    assert.deepEqual(r, { ok: true });
  });

  it('complete / release：不抛错且发射 UPDATE/DELETE SQL', async () => {
    const { db, calls } = makeFakeDb();
    const store = new PostgresFormIdempotencyStore(db as never, makeUow() as never);
    await store.complete({
      scopeKey: 's',
      idempotencyKey: 'k',
      semanticHash: 'hash-1',
      result: { ok: true },
    });
    await store.release('s', 'k');
    assert.ok(
      calls.some((s) => s.includes('UPDATE form_idempotency')),
      'complete 应发射 UPDATE SQL',
    );
    assert.ok(
      calls.some((s) => s.includes('DELETE FROM form_idempotency')),
      'release 应发射 DELETE SQL',
    );
  });
});
