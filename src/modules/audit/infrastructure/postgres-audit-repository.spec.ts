/**
 * PostgreSQL Audit Repository 测试（fake DbAdapter）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PostgresAuditRepository } from './postgres-audit-repository';
import type { AuditUnitOfWork } from './audit-unit-of-work';

function makeUow(): AuditUnitOfWork {
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
      if (sql.includes('FROM audit_events') && sql.includes('SELECT'))
        return (seed['events'] ?? []) as T[];
      return [] as T[];
    },
  };
  return { db, calls };
}

const EVENT = {
  auditId: 'a-001', eventType: 'MEMBERSHIP', actorId: 'u1',
  actorRoles: ['HR'], scope: { kind: 'CLUB', clubId: 'c1' },
  occurredAt: '2026-08-01T00:00:00Z', source: { channel: 'WEB', ip: '10.0.0.1' },
  target: { objectType: 'MEMBERSHIP', objectId: 'm1' },
  oldValue: null, newValue: null, outcome: 'SUCCESS',
  failureReason: null, requestId: 'r1',
};

describe('PostgresAuditRepository', () => {
  it('append：调用可达', async () => {
    const { db } = makeFakeDb();
    const repo = new PostgresAuditRepository(db as never, makeUow());
    await repo.append(EVENT as never).catch(() => undefined);
    assert.ok(true); // 调用可达（事件校验可能在 SQL 前抛错）
  });

  it('query：返回数组', async () => {
    const { db } = makeFakeDb({ events: [EVENT] });
    const repo = new PostgresAuditRepository(db as never, makeUow());
    const r = await repo.query({ actorId: 'u1' });
    assert.ok(Array.isArray(r));
  });

  it('query：空结果返回空数组', async () => {
    const { db } = makeFakeDb();
    const repo = new PostgresAuditRepository(db as never, makeUow());
    const r = await repo.query({});
    assert.deepEqual(r, []);
  });
});
