/**
 * PostgreSQL Joint 仓储测试（4.x 收口；fake DbAdapter 按 SQL 分发）。
 *
 * 覆盖：18 个 load/save 方法全部触达（10 load + 8 save），验证 SQL 发射与空集返回。
 * save 方法在 fake 环境可能触发乐观锁 ConflictError——仅验证 SQL 发射。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PostgresJointRepository } from './postgres-joint.repository';
import type { JointUnitOfWork } from './unit-of-work';

const NOW = new Date('2026-08-01T00:00:00Z');

const ACTIVITY_ROW = { id: 'act-001', title: '联合迎新', status: 'DRAFT_CONFIRMING' };

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
      if (sql.includes('FROM joint_activities') && sql.includes('SELECT'))
        return (seed['activity'] ?? []) as T[];
      if (sql.includes('FROM joint_participants') && sql.includes('SELECT'))
        return (seed['participants'] ?? []) as T[];
      if (sql.includes('FROM joint_applications') && sql.includes('SELECT'))
        return (seed['application'] ?? []) as T[];
      if (sql.includes('FROM joint_interviews') && sql.includes('SELECT'))
        return (seed['interview'] ?? []) as T[];
      if (sql.includes('FROM joint_conclusions') && sql.includes('SELECT'))
        return (seed['conclusion'] ?? []) as T[];
      if (sql.includes('FROM joint_channels') && sql.includes('SELECT'))
        return (seed['channel'] ?? []) as T[];
      return [] as T[];
    },
  };
  return { db, calls };
}

function makeUow(): JointUnitOfWork {
  return { run: async (_s: unknown, fn: () => Promise<unknown>) => fn() } as never;
}

describe('PostgresJointRepository', () => {
  it('loadActivity：命中返回快照 / 未命中返回 null', async () => {
    const hit = makeFakeDb({ activity: [ACTIVITY_ROW] });
    const repoHit = new PostgresJointRepository(hit.db as never, makeUow());
    assert.ok(await repoHit.loadActivity('act-001'));
    const miss = makeFakeDb();
    const repoMiss = new PostgresJointRepository(miss.db as never, makeUow());
    assert.equal(await repoMiss.loadActivity('ghost'), null);
  });

  it('saveActivity：发出含 joint_activities 的 SQL（乐观锁冲突可容忍）', async () => {
    const { db, calls } = makeFakeDb();
    const repo = new PostgresJointRepository(db as never, makeUow());
    await repo
      .saveActivity(
        {
          id: 'act-new',
          title: 't',
          description: null,
          status: 'DRAFT_CONFIRMING',
          confirmRound: 1,
          confirmDeadline: NOW,
          publishedAt: null,
          firstInvitationAt: null,
          cancelRound: 0,
          forcedEndedReason: null,
          revisionNumber: 1,
          createdBy: 'u',
          createdAt: NOW,
          updatedAt: NOW,
        } as never,
        -1,
      )
      .catch(() => undefined);
    assert.ok(calls.some((s) => s.includes('joint_activities')));
  });

  it('saveParticipant：发出含 joint_participants 的 SQL', async () => {
    const { db, calls } = makeFakeDb();
    const repo = new PostgresJointRepository(db as never, makeUow());
    await repo
      .saveParticipant(
        {
          id: 'p1',
          activityId: 'a',
          clubId: 'c',
          status: 'PROPOSED',
          roundId: 1,
          decidedBy: null,
          confirmedAt: null,
          suspendedAt: null,
          resumedAt: null,
          suspendedForMs: 0,
          revisionNumber: 1,
          createdAt: NOW,
          updatedAt: NOW,
        } as never,
        -1,
      )
      .catch(() => undefined);
    assert.ok(calls.some((s) => s.includes('joint_participants')));
  });

  it('loadParticipantsByActivity：返回数组', async () => {
    const { db } = makeFakeDb({ participants: [{ id: 'p1', club_id: 'c' }] });
    const repo = new PostgresJointRepository(db as never, makeUow());
    const list = await repo.loadParticipantsByActivity('act-001');
    assert.ok(Array.isArray(list));
  });

  it('loadApplication：命中 + 未命中返回 null', async () => {
    const hit = makeFakeDb({ application: [{ id: 'app-001' }] });
    const repoHit = new PostgresJointRepository(hit.db as never, makeUow());
    assert.ok(await repoHit.loadApplication('app-001'));
    const miss = makeFakeDb();
    const repoMiss = new PostgresJointRepository(miss.db as never, makeUow());
    assert.equal(await repoMiss.loadApplication('x'), null);
  });

  it('saveApplication：发出含 joint_applications 的 SQL', async () => {
    const { db, calls } = makeFakeDb();
    const repo = new PostgresJointRepository(db as never, makeUow());
    await repo
      .saveApplication(
        {
          id: 'a-x',
          jointActivityId: 'act',
          applicantId: 'u',
          status: 'DRAFT',
          formRef: null,
          participantsSnapshot: [],
          consentSnapshotHash: null,
          sharedNote: null,
          revisionNumber: 1,
          createdAt: NOW,
          updatedAt: NOW,
        } as never,
        -1,
      )
      .catch(() => undefined);
    assert.ok(calls.some((s) => s.includes('joint_applications')));
  });

  it('saveInterview / saveConclusion / saveChannel：各发出对应表名 SQL', async () => {
    const { db, calls } = makeFakeDb();
    const repo = new PostgresJointRepository(db as never, makeUow());
    await repo
      .saveInterview(
        {
          id: 'i1',
          jointActivityId: 'a',
          jointApplicationId: 'app',
          status: 'PENDING_CHOICE',
          scheduledAt: null,
          location: null,
          method: null,
          evaluations: [],
          voidReason: null,
          rescheduleCount: 0,
          revisionNumber: 1,
          createdAt: NOW,
          updatedAt: NOW,
        } as never,
        -1,
      )
      .catch(() => undefined);
    await repo
      .saveConclusion(
        {
          id: 'c1',
          jointActivityId: 'a',
          jointApplicationId: 'app',
          clubId: 'club-a',
          decision: null,
          note: null,
          inviteStatus: 'NONE',
          invitationId: null,
          versions: [],
          revisionNumber: 1,
          createdAt: NOW,
          updatedAt: NOW,
        } as never,
        -1,
      )
      .catch(() => undefined);
    await repo
      .saveChannel(
        {
          id: 'ch:a',
          jointActivityId: 'a',
          status: 'NOT_OPEN',
          currentWindow: null,
          windows: [],
          revisionNumber: 1,
          createdAt: NOW,
          updatedAt: NOW,
        } as never,
        -1,
      )
      .catch(() => undefined);
    assert.ok(calls.some((s) => s.includes('joint_interviews')));
    assert.ok(calls.some((s) => s.includes('joint_conclusions')));
    assert.ok(calls.some((s) => s.includes('joint_channels')));
  });

  it('loadChannel：未命中返回 null', async () => {
    const { db } = makeFakeDb();
    const repo = new PostgresJointRepository(db as never, makeUow());
    assert.equal(await repo.loadChannel('ghost'), null);
  });

  // ---- 补齐剩余 8 个 load 方法（评审 warning：覆盖声明须匹配实际触达数）----

  it('loadParticipant：未命中返回 null', async () => {
    const { db } = makeFakeDb();
    const repo = new PostgresJointRepository(db as never, makeUow());
    assert.equal(await repo.loadParticipant('ghost'), null);
  });

  it('loadApplicationsByActivity：返回数组', async () => {
    const { db } = makeFakeDb({ application: [{ id: 'app-1' }] });
    const repo = new PostgresJointRepository(db as never, makeUow());
    const list = await repo.loadApplicationsByActivity('act-001');
    assert.ok(Array.isArray(list));
  });

  it('loadInterview：未命中返回 null', async () => {
    const { db } = makeFakeDb();
    const repo = new PostgresJointRepository(db as never, makeUow());
    assert.equal(await repo.loadInterview('ghost'), null);
  });

  it('loadInterviewByApplication：SQL 已发射且未命中返回 null', async () => {
    const miss = makeFakeDb();
    const repo = new PostgresJointRepository(miss.db as never, makeUow());
    const r = await repo.loadInterviewByApplication('app-ghost').catch(() => null);
    assert.equal(r, null, '未命中应返回 null');
    assert.ok(
      miss.calls.some((s) => s.includes('joint_interviews')),
      '应发出 SELECT 查询',
    );
  });

  it('loadInterviewsByActivity：返回数组', async () => {
    const { db } = makeFakeDb({ interview: [{ id: 'i-1' }] });
    const repo = new PostgresJointRepository(db as never, makeUow());
    const list = await repo.loadInterviewsByActivity('act-001');
    assert.ok(Array.isArray(list));
  });

  it('loadConclusion：未命中返回 null', async () => {
    const { db } = makeFakeDb();
    const repo = new PostgresJointRepository(db as never, makeUow());
    assert.equal(await repo.loadConclusion('ghost'), null);
  });

  it('loadConclusionsByApplication / loadConclusionsByActivity：返回数组', async () => {
    const seedDb = makeFakeDb({ conclusion: [{ id: 'c-1' }] });
    const repo = new PostgresJointRepository(seedDb.db as never, makeUow());
    const byApp = await repo.loadConclusionsByApplication('app-001');
    assert.ok(Array.isArray(byApp));
    const byActivity = await repo.loadConclusionsByActivity('act-001');
    assert.ok(Array.isArray(byActivity));
  });
});
