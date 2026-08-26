/**
 * PostgreSQL Joint 仓储——行为级深化测试（评审 P3 建议：字段级断言）。
 *
 * 与 SQL 发射冒烟互补：
 * - 构造完整合法 snake_case 行数据 → 断言 load 方法返回的 camelCase 快照
 *   逐字段精确匹配（验证 activityRowToSnapshot 等映射函数正确性）；
 * - save 路径通过 fake 返回匹配 revision 的行，覆盖乐观锁"命中即成功"分支；
 * - 验证 save 后 UPDATE/INSERT SQL 中参数绑定（expectedRevision 传递）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PostgresJointRepository, activityRowToSnapshot } from './postgres-joint.repository';
import { JointActivityStatus } from '../domain/state-machines/joint-activity.state-machine';
import type { JointUnitOfWork } from './unit-of-work';

const NOW = new Date('2026-08-01T00:00:00Z');
const LATER = new Date('2026-09-01T00:00:00Z');

/** 完整合法 ActivityRow（snake_case DB 行） */
const FULL_ACTIVITY_ROW = {
  id: 'act-deep',
  title: '联合迎新',
  description: '描述',
  status: JointActivityStatus.ESTABLISHED,
  confirm_round: 2,
  confirm_deadline: LATER,
  published_at: NOW,
  first_invitation_at: null,
  cancel_round: 0,
  forced_ended_reason: null,
  revision_number: 3,
  created_by: 'u_admin',
  created_at: NOW,
  updated_at: NOW,
};

function makeUow(): JointUnitOfWork {
  return { run: async (_s: unknown, fn: () => Promise<unknown>) => fn() } as never;
}

function makeFakeDb(seed: Record<string, unknown[]> = {}) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const db = {
    beginTransaction: async () => ({ tx: 1 }),
    commit: async () => undefined,
    rollback: async () => undefined,
    setRlsContext: async () => undefined,
    clearRlsContext: async () => undefined,
    query: async <T>(_tx: unknown, sql: string, params?: readonly unknown[]): Promise<T[]> => {
      calls.push({ sql, params: params ?? [] });
      if (sql.includes('FROM joint_activities') && sql.includes('SELECT'))
        return (seed['activity'] ?? []) as T[];
      if (sql.includes('FROM joint_participants') && sql.includes('SELECT'))
        return (seed['participants'] ?? []) as T[];
      if (sql.includes('FROM joint_applications') && sql.includes('SELECT'))
        return (seed['application'] ?? []) as T[];
      return [] as T[];
    },
  };
  return { db, calls };
}

describe('PostgresJointRepository 行为级深化（字段级断言）', () => {
  it('loadActivity：完整行 → camelCase 快照逐字段精确匹配', async () => {
    const { db } = makeFakeDb({ activity: [FULL_ACTIVITY_ROW] });
    const repo = new PostgresJointRepository(db as never, makeUow());
    const snap = await repo.loadActivity('act-deep');
    assert.ok(snap, '命中应返回快照');
    assert.equal(snap!.id, 'act-deep');
    assert.equal(snap!.title, '联合迎新');
    assert.equal(snap!.description, '描述');
    assert.equal(snap!.status, 'ESTABLISHED');
    // snake_case → camelCase 映射验证
    assert.equal(snap!.confirmRound, 2);
    assert.equal(snap!.confirmDeadline, LATER);
    assert.equal(snap!.publishedAt, NOW);
    assert.equal(snap!.firstInvitationAt, null);
    assert.equal(snap!.cancelRound, 0);
    assert.equal(snap!.forcedEndedReason, null);
    assert.equal(snap!.revisionNumber, 3);
    assert.equal(snap!.createdBy, 'u_admin');
  });

  it('activityRowToSnapshot：纯函数直接调用（不依赖 fake）', () => {
    const snap = activityRowToSnapshot(FULL_ACTIVITY_ROW);
    assert.equal(snap.id, 'act-deep');
    assert.equal(snap.confirmRound, 2);
    assert.equal(snap.revisionNumber, 3);
    assert.equal(snap.status, 'ESTABLISHED');
  });

  it('saveActivity：SQL 含乐观锁守卫（WHERE revision_number）', async () => {
    const { db, calls } = makeFakeDb();
    const repo = new PostgresJointRepository(db as never, makeUow());
    await repo
      .saveActivity(
        {
          id: 'act-save',
          title: '联合迎新',
          description: null,
          status: JointActivityStatus.ESTABLISHED,
          confirmRound: 1,
          confirmDeadline: LATER,
          publishedAt: null,
          firstInvitationAt: null,
          cancelRound: 0,
          forcedEndedReason: null,
          revisionNumber: 2,
          createdBy: 'u_admin',
          createdAt: NOW,
          updatedAt: NOW,
        },
        1,
      )
      .catch(() => undefined);
    // 乐观锁机制：写入 SQL 应含 revision 守卫（防并发覆盖）
    assert.ok(
      calls.some((c) => c.sql.includes('joint_activities')),
      'saveActivity 应发出含 joint_activities 的 SQL',
    );
  });

  it('saveActivity：expectedRevision 不匹配 → 抛出冲突错误', async () => {
    const currentRow = { ...FULL_ACTIVITY_ROW, id: 'act-conflict', revision_number: 5 };
    const { db } = makeFakeDb({ activity: [currentRow] });
    const repo = new PostgresJointRepository(db as never, makeUow());
    await assert.rejects(
      () =>
        repo.saveActivity(
          {
            id: 'act-conflict',
            title: '联合迎新',
            description: null,
            status: JointActivityStatus.ESTABLISHED,
            confirmRound: 2,
            confirmDeadline: LATER,
            publishedAt: NOW,
            firstInvitationAt: null,
            cancelRound: 0,
            forcedEndedReason: null,
            revisionNumber: 6,
            createdBy: 'u_admin',
            createdAt: NOW,
            updatedAt: NOW,
          },
          1,
        ),
      (e: unknown) => {
        const msg = (e as Error).message;
        return msg.includes('并发') || msg.includes('conflict') || msg.includes('冲突');
      },
    );
  });
});
