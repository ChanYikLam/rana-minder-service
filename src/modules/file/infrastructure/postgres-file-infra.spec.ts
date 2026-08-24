/**
 * PostgreSQL 访问审计 / 二次确认 / 引用复核单测（4.2 收口；fake DbAdapter）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PostgresAccessAudit } from './postgres-access-audit';
import {
  PostgresFormalDeleteConfirm,
  confirmationFingerprint,
} from './postgres-formal-delete-confirm';
import { PostgresCleanupReferenceGuard } from './postgres-cleanup-reference-guard';

const NOW = new Date('2026-08-24T00:00:00.000Z');

/** fake DbAdapter：按 SQL 模式分发（UPDATE RETURNING / SELECT count / INSERT） */
const makeFakeDb = (opts: { confirmCode?: string; refCount?: number } = {}) => {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const db = {
    beginTransaction: async () => ({ tx: 1 }),
    commit: async () => undefined,
    rollback: async () => undefined,
    setRlsContext: async () => undefined,
    clearRlsContext: async () => undefined,
    query: async <T>(_tx: unknown, sql: string, params: readonly unknown[]): Promise<T[]> => {
      calls.push({ sql, params });
      if (sql.includes('UPDATE file_delete_confirmations')) {
        // verify：code 匹配且未消费 → 模拟消费成功
        if (
          opts.confirmCode !== undefined &&
          params[0] === confirmationFingerprint(opts.confirmCode)
        ) {
          return [{ code: params[0] }] as T[];
        }
        return [] as T[];
      }
      if (sql.includes('SELECT count(*)') && sql.includes('jsonb_array_elements(versions)')) {
        return [{ n: opts.refCount ?? 0 }] as T[];
      }
      if (
        sql.includes('INSERT INTO file_delete_confirmations') ||
        sql.includes('INSERT INTO file_access_audit')
      ) {
        return [] as T[];
      }
      return [] as T[];
    },
  };
  return { db, calls };
};

describe('PostgresAccessAudit（4.2 收口）', () => {
  it('report：事件落库（action/principal/file/sensitive/token/occurred_at）', async () => {
    const { db, calls } = makeFakeDb();
    const audit = new PostgresAccessAudit(db as never);
    await audit.report({
      action: 'DOWNLOAD',
      principalId: 'u1',
      fileId: 'f1',
      sensitive: true,
      token: 'tok-1',
      occurredAt: NOW.toISOString(),
    });
    const insert = calls.find((c) => c.sql.includes('INSERT INTO file_access_audit'));
    assert.ok(insert, 'report 必须发出 INSERT');
    assert.deepEqual(insert!.params.slice(0, 4), ['DOWNLOAD', 'u1', 'f1', true]);
    assert.equal(insert!.params[4], 'tok-1');
  });
});

describe('PostgresFormalDeleteConfirm（4.2 收口）', () => {
  it('verify：已签发且未过期 → true（一次性消费）', async () => {
    const { db } = makeFakeDb({ confirmCode: '123456' });
    const confirm = new PostgresFormalDeleteConfirm(db as never);
    assert.equal(await confirm.verify('123456'), true);
  });

  it('verify：未签发/伪造 → false（不再 fail-closed 一律拒绝，但伪造仍拒）', async () => {
    const { db } = makeFakeDb();
    const confirm = new PostgresFormalDeleteConfirm(db as never);
    assert.equal(await confirm.verify('forged'), false);
  });

  it('issue：存证指纹（不存明文；GOV-008 脱敏）', async () => {
    const { db, calls } = makeFakeDb();
    const confirm = new PostgresFormalDeleteConfirm(db as never);
    await confirm.issue('123456', new Date(NOW.getTime() + 3600_000));
    const insert = calls.find((c) => c.sql.includes('INSERT INTO file_delete_confirmations'));
    assert.ok(insert, 'issue 必须发出 INSERT');
    // 存证的是 SHA-256 指纹而非明文
    assert.equal(insert!.params[0], confirmationFingerprint('123456'));
    assert.notEqual(insert!.params[0], '123456');
  });

  it('confirmationFingerprint：确定性哈希（清单存证与核验比对同一口径）', () => {
    assert.equal(confirmationFingerprint('abc'), confirmationFingerprint('abc'));
    assert.notEqual(confirmationFingerprint('abc'), confirmationFingerprint('abd'));
  });
});

describe('PostgresCleanupReferenceGuard（4.2 收口）', () => {
  it('hasActiveReference：仍有活跃版本引用 → true（拒绝物理删除）', async () => {
    const { db } = makeFakeDb({ refCount: 1 });
    const guard = new PostgresCleanupReferenceGuard(db as never);
    assert.equal(
      await guard.hasActiveReference({
        bucketRole: 'OBJECT',
        keyVersion: 'v1',
        randomKey: 'r1',
        objectKind: 'OBJECT',
        actualSize: 1,
        sha256: 'x',
        storageToken: 't',
      }),
      true,
    );
  });

  it('hasActiveReference：无引用 → false（可安全物理删除；不再恒 fail-closed）', async () => {
    const { db } = makeFakeDb();
    const guard = new PostgresCleanupReferenceGuard(db as never);
    assert.equal(
      await guard.hasActiveReference({
        bucketRole: 'OBJECT',
        keyVersion: 'v1',
        randomKey: 'r9',
        objectKind: 'OBJECT',
        actualSize: 1,
        sha256: 'x',
        storageToken: 't',
      }),
      false,
    );
  });
});
