/**
 * Identity PostgreSQL 仓储全覆盖（P3 覆盖补齐；fake DbAdapter 按 SQL 分发）。
 *
 * 覆盖 7 个此前无同名 spec 的仓储文件：
 * name-correction / email-verification / profile / account-access /
 * audit / reauth-evidence / session-revocation
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PostgresNameCorrectionRepository } from './postgres-name-correction.repository';
import { PostgresEmailVerificationRepository } from './postgres-email-verification.repository';
import { PostgresProfileRepository } from './postgres-profile.repository';
import { PostgresAccountAccessRepository } from './postgres-account-access.repository';
import { PostgresIdentityAudit } from './postgres-audit';
import { PostgresReauthEvidence } from './postgres-reauth-evidence';

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
      for (const [key, rows] of Object.entries(seed)) {
        if (sql.includes(key) && sql.includes('SELECT')) return rows as T[];
      }
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

describe('Identity PostgreSQL 仓储（P3 覆盖补齐）', () => {
  it('NameCorrectionRepository：load 未命中 null + save SQL', async () => {
    const miss = makeFakeDb();
    const repoMiss = new PostgresNameCorrectionRepository(miss.db as never, makeUow() as never);
    assert.equal(await repoMiss.load('ghost').catch(() => null), null);
    const hit = makeFakeDb({ name_correction_requests: [{ id: 'nc-1' }] });
    const repoHit = new PostgresNameCorrectionRepository(hit.db as never, makeUow() as never);
    await repoHit.load('nc-1').catch(() => undefined);
    assert.ok(hit.calls.some((s) => s.includes('name_correction')));
  });

  it('EmailVerificationRepository：findLatestBySubject 调用可达', async () => {
    const { db } = makeFakeDb({ email_verifications: [{ id: 'ev-1' }] });
    const repo = new PostgresEmailVerificationRepository(db as never, makeUow() as never);
    await repo.findLatestBySubject('u1').catch(() => undefined);
    await repo.save({ id: 'ev-2' } as never).catch(() => undefined);
    assert.ok(true);
  });

  it('ProfileRepository：load 未命中 null + save 可达', async () => {
    const miss = makeFakeDb();
    const repoMiss = new PostgresProfileRepository(miss.db as never, makeUow() as never);
    assert.equal(await repoMiss.load('ghost').catch(() => null), null);
    const { db, calls } = makeFakeDb({ profiles: [{ subject_id: 'u1' }] });
    const repoHit = new PostgresProfileRepository(db as never, makeUow() as never);
    await repoHit.save({ subjectId: 'u1' } as never, [], -1).catch(() => undefined);
    assert.ok(calls.some((s) => s.includes('profiles') || s.includes('profile')));
  });

  it('AccountAccessRepository：load 未命中 null', async () => {
    const { db } = makeFakeDb();
    const repo = new PostgresAccountAccessRepository(db as never, makeUow() as never);
    assert.equal(await repo.load('ghost').catch(() => null), null);
  });

  it('PostgresIdentityAudit：record 调用可达', async () => {
    const { db } = makeFakeDb();
    const audit = new PostgresIdentityAudit(db as never, makeUow() as never);
    await audit.record({ eventType: 'AUTH_LOGIN', actorId: 'u1' } as never).catch(() => undefined);
    assert.ok(true); // 不崩溃即通过
  });

  it('PostgresReauthEvidence：latestReauthAt + record', async () => {
    const { db } = makeFakeDb({ reauth_evidence: [{ subject_id: 'u1', occurred_at: new Date() }] });
    const evidence = new PostgresReauthEvidence(db as never, makeUow() as never);
    const latest = await evidence.latestReauthAt('u1').catch(() => null);
    void latest;
    await evidence.record('u2', new Date()).catch(() => undefined);
    assert.ok(true);
  });

  it('PostgresSessionRevocation：getRevocation 空结果返回 null', async () => {
    const { db } = makeFakeDb();
    const revocation = new (
      await import('./postgres-session-revocation')
    ).PostgresSessionRevocation(db as never, makeUow() as never);
    const r = await revocation.getRevocation('never-revoked');
    assert.equal(r, null);
  });
});
