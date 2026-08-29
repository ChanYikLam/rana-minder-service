/**
 * PostgreSQL 身份域仓储单元测试（infrastructure）。
 *
 * 覆盖：快照→行映射、upsert 参数、load 缺行返回 null、领域事件序列化入审计表、
 * 全部读写经工作单元活动事务（无事务失败关闭）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityUnitOfWork } from './unit-of-work';
import { FakeDbAdapter } from './testing/fake-db-adapter';
import { PostgresProfileRepository } from './postgres-profile.repository';
import { PostgresEmailVerificationRepository } from './postgres-email-verification.repository';
import { PostgresProfileSyncIntentRepository } from './postgres-sync-intent.repository';
import { PostgresAccountAccessRepository } from './postgres-account-access.repository';
import { PostgresIdentityAudit } from './postgres-audit';
import { ProfileWriteGateState } from '../domain/state-machines/profile-write-gate.state-machine';
import { AccountAccessState } from '../domain/state-machines/account-access.state-machine';
import { ProfileSyncState } from '../domain/state-machines/profile-sync.state-machine';
import type { ProfileSnapshot } from '../domain/models/profile';
import type { EmailVerificationSnapshot } from '../domain/models/email-verification';
import type { ProfileSyncIntentSnapshot } from '../domain/models/profile-sync-intent';
import type { AccountAccessSnapshot } from '../domain/models/account-access';
import type { ProfileDomainEvent } from '../domain/models/profile';
import type { ProfileSyncDomainEvent } from '../domain/models/profile-sync-intent';

const now = new Date('2026-08-20T12:00:00.000Z');

async function inTx<T>(uow: IdentityUnitOfWork, fn: () => Promise<T>): Promise<T> {
  return uow.run({ kind: 'single', subjectId: 'user-1' }, fn);
}

describe('PostgresProfileRepository', () => {
  it('load：行 → 快照；缺行 → null', async () => {
    const db = new FakeDbAdapter();
    db.seed('identity_profiles', [
      {
        subject_id: 'user-1',
        fields: JSON.stringify({ phone: '13800000000', college: '计算机学院' }),
        email_verified: true,
        verified_email: 'a@example.com',
        pending_email: null,
        version: 4,
        gate_state: ProfileWriteGateState.WRITABLE,
        restrictions: JSON.stringify([
          { scopeKey: 'club:2', reason: 'x', since: now.toISOString() },
        ]),
      },
    ]);
    const uow = new IdentityUnitOfWork(db);
    const repo = new PostgresProfileRepository(db, uow);

    const snapshot = await inTx(uow, () => repo.load('user-1'));
    assert.ok(snapshot);
    assert.equal(snapshot.version, 4);
    assert.equal(snapshot.fields.phone, '13800000000');
    assert.equal(snapshot.emailVerified, true);
    assert.equal(snapshot.gateState, ProfileWriteGateState.WRITABLE);
    assert.equal(snapshot.restrictions[0].scopeKey, 'club:2');

    const missing = await inTx(uow, () => repo.load('nobody'));
    assert.equal(missing, null);
  });

  it('save：upsert 参数 + 乐观锁守卫参数；无内嵌审计（审计归应用层 record）', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    const repo = new PostgresProfileRepository(db, uow);
    const snapshot: ProfileSnapshot = {
      subjectId: 'user-1',
      fields: { phone: '13900000000' },
      emailVerified: true,
      verifiedEmail: 'a@example.com',
      pendingEmail: null,
      version: 5,
      gateState: ProfileWriteGateState.WRITABLE,
      restrictions: [],
    };
    const event: ProfileDomainEvent = {
      type: 'PROFILE_SAVED',
      occurredAt: now,
      payload: { subjectId: 'user-1', version: 5, changedFields: ['phone'] },
    };

    await inTx(uow, () => repo.save(snapshot, [event], 4));

    assert.equal(db.queries.length, 1);
    const upsert = db.queries[0];
    assert.match(upsert.sql, /ON CONFLICT \(subject_id\) DO UPDATE/);
    assert.match(upsert.sql, /WHERE identity_profiles\.version = \$9/);
    assert.equal(upsert.params[0], 'user-1');
    assert.deepEqual(JSON.parse(upsert.params[1] as string), { phone: '13900000000' });
    assert.equal(upsert.params[5], 5);
    assert.equal(upsert.params[8], 4);
    assert.doesNotMatch(upsert.sql, /identity_audit/);
  });

  it('save：SQL 层版本守卫——预期版本不匹配 → 0 行更新 → IFC-ERR-008', async () => {
    const db = new FakeDbAdapter();
    db.seed('identity_profiles', [
      {
        subject_id: 'user-1',
        fields: '{}',
        email_verified: false,
        verified_email: null,
        pending_email: null,
        version: 5,
        gate_state: ProfileWriteGateState.WRITABLE,
        restrictions: '[]',
      },
    ]);
    const uow = new IdentityUnitOfWork(db);
    const repo = new PostgresProfileRepository(db, uow);
    const snapshot: ProfileSnapshot = {
      subjectId: 'user-1',
      fields: { phone: '13900000000' },
      emailVerified: true,
      verifiedEmail: null,
      pendingEmail: null,
      version: 6,
      gateState: ProfileWriteGateState.WRITABLE,
      restrictions: [],
    };

    await assert.rejects(
      inTx(uow, () => repo.save(snapshot, [], 4)),
      (error: Error & { code?: string }) =>
        error.name === 'IdentityCommandError' && error.code === 'IFC-ERR-008',
    );

    const matchingVersion = await inTx(uow, () => repo.save(snapshot, [], 5));
    assert.equal(matchingVersion, undefined);
  });

  it('无活动事务读写 → 失败关闭', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    const repo = new PostgresProfileRepository(db, uow);
    await assert.rejects(repo.load('user-1'), /无活动事务/);
  });
});

describe('PostgresEmailVerificationRepository', () => {
  const snapshot: EmailVerificationSnapshot = {
    id: 'v-1',
    subjectId: 'user-1',
    email: 'new@example.com',
    tokenHash: 'abc123',
    expiresAt: new Date(now.getTime() + 86400000),
    consumedAt: null,
    requestVersion: 2,
    createdAt: now,
  };

  it('save→load 往返与 findLatestBySubjectAndEmail 排序', async () => {
    const db = new FakeDbAdapter();
    db.seed('email_verification_requests', [
      {
        id: 'v-1',
        subject_id: 'user-1',
        email: 'new@example.com',
        token_hash: 'abc123',
        expires_at: snapshot.expiresAt,
        consumed_at: null,
        request_version: 2,
        created_at: now,
      },
      {
        id: 'v-0',
        subject_id: 'user-1',
        email: 'new@example.com',
        token_hash: 'old',
        expires_at: now,
        consumed_at: null,
        request_version: 1,
        created_at: new Date(now.getTime() - 60000),
      },
    ]);
    const uow = new IdentityUnitOfWork(db);
    const repo = new PostgresEmailVerificationRepository(db, uow);

    const loaded = await inTx(uow, () => repo.load('v-1'));
    assert.equal(loaded?.email, 'new@example.com');
    assert.equal(loaded?.requestVersion, 2);

    const latest = await inTx(uow, () =>
      repo.findLatestBySubjectAndEmail('user-1', 'new@example.com'),
    );
    assert.equal(latest?.id, 'v-1');
    assert.equal(latest?.requestVersion, 2);
  });

  it('findLatestBySubject 按同主体最高 requestVersion 返回（跨邮箱单调递增依据）', async () => {
    const db = new FakeDbAdapter();
    db.seed('email_verification_requests', [
      {
        id: 'v-a',
        subject_id: 'user-1',
        email: 'a@example.com',
        token_hash: 'a',
        expires_at: now,
        consumed_at: null,
        request_version: 1,
        created_at: now,
      },
      {
        id: 'v-b',
        subject_id: 'user-1',
        email: 'b@example.com',
        token_hash: 'b',
        expires_at: now,
        consumed_at: null,
        request_version: 3,
        created_at: new Date(now.getTime() + 60000),
      },
      {
        id: 'v-other',
        subject_id: 'user-2',
        email: 'c@example.com',
        token_hash: 'c',
        expires_at: now,
        consumed_at: null,
        request_version: 9,
        created_at: now,
      },
    ]);
    const uow = new IdentityUnitOfWork(db);
    const repo = new PostgresEmailVerificationRepository(db, uow);

    const latest = await inTx(uow, () => repo.findLatestBySubject('user-1'));
    assert.equal(latest?.id, 'v-b');
    assert.equal(latest?.requestVersion, 3);
  });

  it('save：只存令牌哈希，不存明文', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    const repo = new PostgresEmailVerificationRepository(db, uow);

    const affected = await inTx(uow, () => repo.save(snapshot));

    const upsert = db.queries[0];
    assert.equal(upsert.params[3], 'abc123');
    assert.equal(upsert.params.includes('secret-token'), false);
    assert.equal(affected, 1);
  });

  it('save：SQL 层单次消费守卫（WHERE consumed_at IS NULL + RETURNING id）', async () => {
    const db = new FakeDbAdapter();
    db.seed('email_verification_requests', [
      {
        id: 'v-1',
        subject_id: 'user-1',
        email: 'new@example.com',
        token_hash: 'abc123',
        expires_at: snapshot.expiresAt,
        consumed_at: new Date(now.getTime() + 1000),
        request_version: 2,
        created_at: now,
      },
    ]);
    const uow = new IdentityUnitOfWork(db);
    const repo = new PostgresEmailVerificationRepository(db, uow);

    // 尝试用 consumed_at=null 重放覆盖已消费记录；SQL 层以守卫拦截（并发重复消费防护）。
    const affected = await inTx(uow, () => repo.save({ ...snapshot, consumedAt: null }));

    assert.equal(typeof affected, 'number');
    const upsert = db.queries[0];
    assert.match(upsert.sql, /WHERE email_verification_requests\.consumed_at IS NULL/);
    assert.match(upsert.sql, /RETURNING id/);
  });
});

describe('PostgresProfileSyncIntentRepository', () => {
  it('load 按 (subjectId, field) 定位；save upsert 并序列化事件', async () => {
    const db = new FakeDbAdapter();
    db.seed('profile_sync_intents', [
      {
        subject_id: 'user-1',
        field: 'phone',
        id: 'intent-1',
        target_version: 4,
        prior_value: '13700000000',
        target_value: '13800000000',
        readback_value: null,
        state: ProfileSyncState.PENDING_SYNC,
        conflict_version: null,
        attempts: 0,
        retry_at: null,
        failed_since: null,
        resolved_at: null,
        created_at: now,
      },
    ]);
    const uow = new IdentityUnitOfWork(db);
    const repo = new PostgresProfileSyncIntentRepository(db, uow);

    const loaded = await inTx(uow, () => repo.load('user-1', 'phone'));
    assert.ok(loaded);
    assert.equal(loaded.state, ProfileSyncState.PENDING_SYNC);
    assert.equal(loaded.targetVersion, 4);

    const missing = await inTx(uow, () => repo.load('user-1', 'email'));
    assert.equal(missing, null);

    const upserted: ProfileSyncIntentSnapshot = {
      ...loaded!,
      state: ProfileSyncState.RETRYING,
      attempts: 1,
    };
    const event: ProfileSyncDomainEvent = {
      type: 'SYNC_STATE_TRANSITIONED',
      occurredAt: now,
      payload: {
        subjectId: 'user-1',
        field: 'phone',
        targetVersion: 4,
        fromState: 'PENDING_SYNC',
        toState: 'RETRYING',
      },
    };
    await inTx(uow, () => repo.save(upserted, [event]));
    assert.equal(db.queries.length, 3);
    const upsert = db.queries[2];
    assert.match(upsert.sql, /ON CONFLICT \(subject_id, field\) DO UPDATE/);
    assert.equal(upsert.params[7], ProfileSyncState.RETRYING);
    assert.equal(upsert.params[9], 1);
    assert.doesNotMatch(upsert.sql, /identity_audit/);
  });
});

describe('PostgresAccountAccessRepository', () => {
  it('load/save 往返', async () => {
    const db = new FakeDbAdapter();
    db.seed('account_access', [
      {
        subject_id: 'user-1',
        state: AccountAccessState.UNVERIFIABLE,
        state_version: 2,
        degraded_since: now,
        last_trusted_observation_at: now,
        session_revoke_version: 0,
      },
    ]);
    const uow = new IdentityUnitOfWork(db);
    const repo = new PostgresAccountAccessRepository(db, uow);

    const loaded = await inTx(uow, () => repo.load('user-1'));
    assert.ok(loaded);
    assert.equal(loaded.state, AccountAccessState.UNVERIFIABLE);
    assert.equal(loaded.sessionRevokeVersion, 0);

    const snapshot: AccountAccessSnapshot = {
      subjectId: 'user-1',
      state: AccountAccessState.ACTIVE,
      stateVersion: 3,
      degradedSince: null,
      lastTrustedObservationAt: now,
      sessionRevokeVersion: 1,
    };
    // Top 1/C1：save 带 expectedStateVersion（读取时旧值 2）+ SQL CAS 守卫
    await inTx(uow, () => repo.save(snapshot, 2, []));
    const upsert = db.queries[1];
    assert.match(upsert.sql, /ON CONFLICT \(subject_id\) DO UPDATE/);
    assert.match(upsert.sql, /WHERE account_access\.state_version = \$7/);
    assert.equal(upsert.params[1], AccountAccessState.ACTIVE);
    assert.equal(upsert.params[5], 1);
    assert.equal(upsert.params[6], 2, 'expectedStateVersion 传入 CAS 守卫');
  });
});

describe('PostgresIdentityAudit', () => {
  it('record：脱敏摘要写入同一事务', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    const audit = new PostgresIdentityAudit(db, uow);

    await inTx(uow, () =>
      audit.record({
        type: 'EMAIL_VERIFICATION',
        subjectId: 'user-1',
        occurredAt: now,
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
});
