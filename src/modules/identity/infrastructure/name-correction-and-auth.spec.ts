/**
 * 姓名更正/重认证证据/会话失效 PostgreSQL 存储单元测试（IDN-016、CAS-REC-003、IDN-008）。
 *
 * 覆盖：申请快照落库与读取（含部分唯一待裁决查询）、重认证证据登记与读取、
 * 会话批量失效的 SQL 参数与事务上下文归属。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityUnitOfWork } from './unit-of-work';
import { FakeDbAdapter } from './testing/fake-db-adapter';
import { PostgresNameCorrectionRepository } from './postgres-name-correction.repository';
import { PostgresReauthEvidence } from './postgres-reauth-evidence';
import { PostgresSessionRevocation } from './postgres-session-revocation';
import { NameCorrectionState } from '../domain/state-machines/name-correction.state-machine';
import type { NameCorrectionRequestSnapshot } from '../domain/models/name-correction-request';

const now = new Date('2026-08-20T12:00:00.000Z');

function snapshot(): NameCorrectionRequestSnapshot {
  return {
    id: 'req-1',
    subjectId: 'user-1',
    oldName: '旧姓名',
    requestedName: '新姓名',
    proofReference: null,
    status: NameCorrectionState.SUBMITTED,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    appliedAt: null,
    version: 0,
    createdAt: now,
  };
}

describe('PostgresNameCorrectionRepository（IDN-016）', () => {
  it('保存后可按 id 读取（查询归属当前活动事务）', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    const repository = new PostgresNameCorrectionRepository(db, uow);

    await uow.run({ kind: 'single', subjectId: 'user-1' }, async () => {
      await repository.save(snapshot(), [], 0);
      db.seed('name_correction_requests', [
        {
          id: 'req-1',
          subject_id: 'user-1',
          old_name: '旧姓名',
          requested_name: '新姓名',
          status: 'SUBMITTED',
        },
      ]);
      const loaded = await repository.load('req-1');
      assert.equal(loaded?.id, 'req-1');
      assert.equal(loaded?.requestedName, '新姓名');
    });
    assert.equal(
      db.queries.some((q) => q.sql.includes('FROM name_correction_requests')),
      true,
    );
  });

  it('findPendingBySubject 只查询 SUBMITTED（部分唯一约束语义）', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    const repository = new PostgresNameCorrectionRepository(db, uow);
    db.seed('name_correction_requests', [
      { id: 'req-decided', subject_id: 'user-1', status: 'APPROVED' },
      { id: 'req-pending', subject_id: 'user-1', status: 'SUBMITTED' },
    ]);

    await uow.run({ kind: 'single', subjectId: 'user-1' }, async () => {
      await repository.findPendingBySubject('user-1');
    });

    const query = db.queries.find((q) => q.sql.includes('status'))!;
    assert.equal(query.sql.includes("status = 'SUBMITTED'"), true);
    assert.deepEqual(query.params, ['user-1']);
  });

  it('save：SQL 层版本守卫——预期版本不匹配 → 0 行更新 → IFC-ERR-008（防并发重复裁决）', async () => {
    const db = new FakeDbAdapter();
    db.seed('name_correction_requests', [
      {
        id: 'req-1',
        subject_id: 'user-1',
        old_name: '旧姓名',
        requested_name: '新姓名',
        status: 'APPROVED',
        version: 1,
      },
    ]);
    const uow = new IdentityUnitOfWork(db);
    const repository = new PostgresNameCorrectionRepository(db, uow);

    // 预期版本 0 与库中当前版本 1 不匹配 → 0 行更新 → 版本冲突。
    await assert.rejects(
      uow.run({ kind: 'single', subjectId: 'user-1' }, () => repository.save(snapshot(), [], 0)),
      (error: Error & { code?: string }) =>
        error.name === 'IdentityCommandError' && error.code === 'IFC-ERR-008',
    );

    // 预期版本与库中当前版本匹配 → 更新成功。
    await uow.run({ kind: 'single', subjectId: 'user-1' }, () =>
      repository.save(snapshot(), [], 1),
    );

    const successful = db.queries[db.queries.length - 1];
    assert.match(successful.sql, /WHERE name_correction_requests\.version = \$13/);
    assert.equal(successful.params[12], 1);
    assert.match(successful.sql, /RETURNING id/);
  });
});

describe('PostgresReauthEvidence（CAS-REC-003）', () => {
  it('登记后读取最近重认证时间', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    const evidence = new PostgresReauthEvidence(db, uow);

    await uow.run({ kind: 'single', subjectId: 'user-1' }, async () => {
      await evidence.record('user-1', now);
      db.seed('auth_reauth_evidence', [{ subject_id: 'user-1', reauth_at: now }]);
      const reauthAt = await evidence.latestReauthAt('user-1');
      assert.equal(reauthAt?.getTime(), now.getTime());
    });
  });

  it('无证据 → null（失败关闭判定的缺失分支）', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    const evidence = new PostgresReauthEvidence(db, uow);

    await uow.run({ kind: 'single', subjectId: 'user-1' }, async () => {
      assert.equal(await evidence.latestReauthAt('user-1'), null);
    });
  });
});

describe('PostgresSessionRevocation（IDN-008）', () => {
  it('按主体批量失效未撤销会话并推进版本', async () => {
    const db = new FakeDbAdapter();
    const uow = new IdentityUnitOfWork(db);
    const revocation = new PostgresSessionRevocation(db, uow);

    await uow.run({ kind: 'single', subjectId: 'user-1' }, async () => {
      await revocation.invalidateSessions('user-1', 3);
    });

    const update = db.queries[0];
    assert.equal(update.sql.includes('UPDATE auth_sessions'), true);
    assert.equal(update.sql.includes('revoked_at IS NULL'), true);
    assert.deepEqual(update.params, ['user-1', 3]);
  });
});
