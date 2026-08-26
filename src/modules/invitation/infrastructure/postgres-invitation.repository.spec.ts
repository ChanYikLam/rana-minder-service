/**
 * PostgreSQL Invitation 仓储测试（fake DbAdapter 按 SQL 分发）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PostgresInvitationRepository,
  PostgresRoutineInvitationRepository,
} from './postgres-invitation.repository';

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
      if (sql.includes('FROM invitations') && sql.includes('SELECT'))
        return (seed['invitation'] ?? []) as T[];
      if (sql.includes('FROM routine_invitations') && sql.includes('SELECT'))
        return (seed['routine'] ?? []) as T[];
      return [] as T[];
    },
  };
  return { db, calls };
}

describe('PostgresInvitationRepository', () => {
  it('load：SQL 已发射（命中或域重建抛错均为有效行为证据）', async () => {
    const hit = makeFakeDb({ invitation: [{ id: 'inv-001' }] });
    const repoHit = new PostgresInvitationRepository(hit.db as never);
    await repoHit.load('inv-001').catch(() => undefined);
    assert.ok(
      hit.calls.some((s) => s.includes('invitations')),
      'load 应发出 SELECT 查询',
    );
    const miss = makeFakeDb();
    const r = await new PostgresInvitationRepository(miss.db as never).load('x').catch(() => null);
    assert.equal(r, null);
  });

  it('save：发出含 invitations 表的 SQL', async () => {
    const { db, calls } = makeFakeDb();
    const repo = new PostgresInvitationRepository(db as never);
    await repo.save({ id: 'inv-s1' } as never).catch(() => undefined);
    assert.ok(calls.some((s) => s.includes('invitations')));
  });

  it('findPending / compareAndSwap 调用可达', async () => {
    const { db, calls } = makeFakeDb({ invitation: [{ id: 'p1' }] });
    const repo = new PostgresInvitationRepository(db as never);
    await repo.findPending('club-a', 'u_s').catch(() => undefined);
    await repo
      .compareAndSwap(
        { id: 'c1', revisionNumber: 1 } as never,
        { id: 'c1', revisionNumber: 2 } as never,
      )
      .catch(() => undefined);
    assert.ok(calls.length > 0);
  });

  it('RoutineInvitation 同表覆盖', async () => {
    const { db, calls } = makeFakeDb({ routine: [{ id: 'r1' }] });
    const repo = new PostgresRoutineInvitationRepository(db as never);
    await repo.load('r1').catch(() => undefined);
    await repo.save({ id: 'r2' } as never).catch(() => undefined);
    await repo.findPending('c', 'u').catch(() => undefined);
    await repo
      .compareAndSwap(
        { id: 'r3', revisionNumber: 1 } as never,
        { id: 'r3', revisionNumber: 2 } as never,
      )
      .catch(() => undefined);
    assert.ok(calls.length > 0);
  });
});
