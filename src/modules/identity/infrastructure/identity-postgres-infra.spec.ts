/**
 * Identity PostgreSQL 仓储覆盖（P3 覆盖补齐；FakeDbAdapter 按 SQL 断言真实行为）。
 *
 * 覆盖 7 个此前无同名 spec 的仓储文件：
 * name-correction / email-verification / profile / account-access /
 * audit / reauth-evidence / session-revocation。
 *
 * 相对既有 spec（repositories.spec.ts / name-correction-and-auth.spec.ts）只补
 * 此前缺失的断言路径：session-revocation 的 invalidateAllSessions 全路径、
 * getRevocation 命中回读，以及对 audit 的显式 identity_audit INSERT 断言。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { IdentityUnitOfWork } from './unit-of-work';
import { FakeDbAdapter } from './testing/fake-db-adapter';
import { PostgresNameCorrectionRepository } from './postgres-name-correction.repository';
import { PostgresEmailVerificationRepository } from './postgres-email-verification.repository';
import { PostgresProfileRepository } from './postgres-profile.repository';
import { PostgresAccountAccessRepository } from './postgres-account-access.repository';
import { PostgresIdentityAudit } from './postgres-audit';
import { PostgresReauthEvidence } from './postgres-reauth-evidence';
import { PostgresSessionRevocation } from './postgres-session-revocation';

async function inTx<T>(uow: IdentityUnitOfWork, fn: () => Promise<T>): Promise<T> {
  return uow.run({ kind: 'single', subjectId: 'user-1' }, fn);
}

describe('Identity PostgreSQL 仓储（P3 覆盖补齐）', () => {
  it('NameCorrectionRepository：load 未命中 null，命中回读', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    const repo = new PostgresNameCorrectionRepository(db, uow);

    assert.equal(await inTx(uow, () => repo.load('ghost')), null);

    db.seed('name_correction_requests', [
      { id: 'nc-1', subject_id: 'user-1', requested_name: '新姓名', status: 'SUBMITTED' },
    ]);
    const loaded = await inTx(uow, () => repo.load('nc-1'));
    assert.equal(loaded?.id, 'nc-1');
    assert.equal(loaded?.requestedName, '新姓名');
  });

  it('EmailVerificationRepository：findLatestBySubject 命中回读', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    const repo = new PostgresEmailVerificationRepository(db, uow);
    const now = new Date('2026-08-20T12:00:00.000Z');
    db.seed('email_verification_requests', [
      { id: 'ev-1', subject_id: 'user-1', email: 'a@example.com', occurred_at: now },
    ]);

    const hit = await inTx(uow, () => repo.findLatestBySubject('user-1'));
    assert.equal(hit?.id, 'ev-1');
    assert.equal(
      db.queries.some((q) => q.sql.includes('FROM email_verification_requests')),
      true,
    );
  });

  it('ProfileRepository：load 未命中 null，save 回写 subject 资料表', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    const repo = new PostgresProfileRepository(db, uow);

    assert.equal(await inTx(uow, () => repo.load('ghost')), null);

    db.seed('identity_profiles', [{ subject_id: 'user-1', display_name: '旧名', version: 1 }]);
    await inTx(uow, () => repo.save({ subjectId: 'user-1', displayName: '新名' } as never, [], 1));
    const upsert = db.queries.find((q) => /INSERT INTO identity_profiles/i.test(q.sql));
    assert.ok(upsert, '应执行 identity_profiles upsert');
    assert.match(upsert.sql, /ON CONFLICT \(subject_id\)/);
  });

  it('AccountAccessRepository：load 未命中 null', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    const repo = new PostgresAccountAccessRepository(db, uow);
    assert.equal(await inTx(uow, () => repo.load('ghost')), null);
  });

  it('PostgresIdentityAudit：record 显式落库 identity_audit（脱敏摘要 + traceId）', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    const audit = new PostgresIdentityAudit(db, uow);

    await inTx(uow, () =>
      audit.record({
        type: 'EMAIL_VERIFICATION',
        subjectId: 'user-1',
        occurredAt: new Date('2026-08-20T12:00:00.000Z'),
        actor: 'user-1',
        traceId: 'tr-1',
        summary: { requestVersion: 1, verified: false },
      }),
    );

    const insert = db.queries[0];
    assert.match(insert.sql, /INSERT INTO identity_audit/);
    assert.equal(insert.params[1], 'EMAIL_VERIFICATION');
    assert.equal(insert.params[2], 'user-1');
    assert.equal(insert.params[5], '{"requestVersion":1,"verified":false}');
    assert.equal(insert.params[6], 'tr-1');
  });

  it('PostgresReauthEvidence：latestReauthAt 命中回读 + record 写入 auth_reauth_evidence', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    const evidence = new PostgresReauthEvidence(db, uow);
    const now = new Date('2026-08-20T12:00:00.000Z');

    assert.equal(await inTx(uow, () => evidence.latestReauthAt('ghost')), null);

    await inTx(uow, () => evidence.record('user-1', now));
    db.seed('auth_reauth_evidence', [{ subject_id: 'user-1', reauth_at: now }]);
    const hit = await inTx(uow, () => evidence.latestReauthAt('user-1'));
    assert.equal(hit?.getTime(), now.getTime());
    assert.equal(
      db.queries.some((q) => /INSERT INTO auth_reauth_evidence/i.test(q.sql)),
      true,
    );
  });

  it('PostgresSessionRevocation：invalidateAllSessions 先加行锁再推进撤销版本（RETURNING）', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    const revocation = new PostgresSessionRevocation(db, uow);
    db.seed('auth_sessions', [
      { session_id: 's1', subject_id: 'user-1', revoke_version: 0, revoked_at: null },
    ]);

    await inTx(uow, () => revocation.invalidateAllSessions('user-1'));

    const lockQuery = db.queries[0];
    assert.match(lockQuery.sql, /SELECT session_id FROM auth_sessions/);
    assert.match(lockQuery.sql, /FOR UPDATE/);
    const update = db.queries[1];
    assert.match(update.sql, /UPDATE auth_sessions/);
    assert.match(update.sql, /revoked_at IS NULL/);
    assert.match(update.sql, /RETURNING revoke_version/);
    assert.equal(update.params[0], 'user-1');
  });

  it('PostgresSessionRevocation：getRevocation 无记录返回 null，有记录返回撤销版本', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    const revocation = new PostgresSessionRevocation(db, uow);

    assert.equal(await revocation.getRevocation('never-revoked'), null);

    db.seed('auth_sessions', [
      { session_id: 's1', subject_id: 'user-1', revoke_version: 3, revoked_at: new Date() },
    ]);
    const hit = await revocation.getRevocation('user-1');
    assert.equal(hit?.revokeVersion, 3);
  });
});
