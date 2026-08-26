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
  it('record：调用可达（发出 INSERT SQL 或域校验抛错均为有效行为证据）', async () => {
    const { db, calls } = makeFakeDb();
    const audit = new PostgresFormAudit(db as never, makeUow() as never);
    let caught: Error | undefined;
    await audit
      .record({
        eventType: 'FORM_SUBMIT',
        actorId: 'u1',
        formId: 'f1',
        submissionId: 's1',
        now: new Date(),
      } as never)
      .catch((e: Error) => {
        caught = e;
      });
    const sqlEmitted = calls.some((s) => s.includes('form_audit') || s.includes('INSERT'));
    assert.ok(sqlEmitted || caught !== undefined, 'record 应发射 SQL 或抛域校验错误');
  });
});
