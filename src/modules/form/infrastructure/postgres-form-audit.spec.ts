/**
 * Form PostgreSQL Audit 测试（P3 覆盖补齐）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PostgresFormAudit } from './postgres-form-audit';

function makeUow() {
  return {
    active: { tx: 1 },
    run: async (_s: unknown, fn: () => Promise<unknown>) => fn(),
  };
}

function makeFakeDb() {
  const calls: string[] = [];
  const db = {
    beginTransaction: async () => ({ tx: 1 }),
    commit: async () => undefined,
    rollback: async () => undefined,
    setRlsContext: async () => undefined,
    clearRlsContext: async () => undefined,
    query: async <T>(_tx: unknown, sql: string): Promise<T[]> => {
      calls.push(sql);
      return [] as T[];
    },
  };
  return { db, calls };
}

describe('PostgresFormAudit', () => {
  it('record：按真实 FormAuditFact 字段发出 INSERT SQL', async () => {
    const { db, calls } = makeFakeDb();
    const audit = new PostgresFormAudit(db as never, makeUow() as never);
    await audit.record({
      type: 'FORM_SUBMISSION_CREATED',
      subjectId: 'f1',
      occurredAt: new Date('2026-01-01T00:00:00Z'),
      actor: 'u1',
      summary: { status: 'draft' },
      traceId: null,
    });
    const sqlEmitted = calls.some((s) => s.includes('INSERT INTO form_audit'));
    assert.ok(sqlEmitted, 'record 应发射 INSERT INTO form_audit SQL');
  });
});
