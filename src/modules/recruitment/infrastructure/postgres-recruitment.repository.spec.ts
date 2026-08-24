/**
 * PostgreSQL 招新仓储行映射单测（4.4 infrastructure；纯函数，不依赖真实库）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  activityRowToSnapshot,
  channelRowToSnapshot,
  applicationRowToSnapshot,
  departmentPathRowToSnapshot,
  interviewRowToSnapshot,
  remedyWindowRowToSnapshot,
  PostgresRecruitmentRepository,
} from './postgres-recruitment.repository';
import { RecruitmentUnitOfWork } from './unit-of-work';

const NOW = new Date('2026-01-01T00:00:00Z');

describe('postgres recruitment repository row mapping', () => {
  it('活动行映射', () => {
    const snap = activityRowToSnapshot({
      id: 'a1',
      club_id: 'c1',
      title: '秋招',
      description: null,
      status: 'OPEN',
      paused: false,
      end_date: null,
      created_by: 'm1',
      created_at: NOW,
      updated_at: NOW,
    });
    assert.strictEqual(snap.id, 'a1');
    assert.strictEqual(snap.status, 'OPEN');
    assert.strictEqual(snap.paused, false);
  });

  it('通道行映射（含暂停态）', () => {
    const snap = channelRowToSnapshot({
      id: 'ch1',
      activity_id: 'a1',
      club_id: 'c1',
      status: 'PAUSED',
      open_at: NOW,
      close_at: null,
      deadline: null,
      min_choices: 1,
      max_choices: 1,
      created_at: NOW,
      updated_at: NOW,
    });
    assert.strictEqual(snap.status, 'PAUSED');
    assert.strictEqual(snap.openAt, NOW);
    assert.strictEqual(snap.closeAt, null);
  });

  it('申请行映射（JSONB 字符串与 null 表单引用）', () => {
    const snap = applicationRowToSnapshot({
      id: 'app1',
      activity_id: 'a1',
      channel_id: 'ch1',
      club_id: 'c1',
      applicant_id: 'u1',
      status: 'SUBMITTED',
      department_choices: '[{"departmentId":"d1","order":1}]',
      form_ref: null,
      qualify_snapshot: '{"ok":true}',
      revision_number: 2,
      revisions: '[{"revision":1}]',
      supplement_due_at: null,
      created_at: NOW,
      updated_at: NOW,
    });
    assert.strictEqual(snap.status, 'SUBMITTED');
    assert.deepStrictEqual(snap.departmentChoices, [{ departmentId: 'd1', order: 1 }]);
    assert.strictEqual(snap.formRef, null);
    assert.deepStrictEqual(snap.qualifySnapshot, { ok: true });
    assert.strictEqual(snap.revisionNumber, 2);
    assert.strictEqual(snap.revisions.length, 1);
  });

  it('部门路径行映射（决定版本与挂起前态）', () => {
    const snap = departmentPathRowToSnapshot({
      id: 'p1',
      application_id: 'app1',
      activity_id: 'a1',
      club_id: 'c1',
      department_id: 'd1',
      status: 'ADMITTED',
      revision_number: 0,
      allow_transfer: false,
      published: false,
      decisions:
        '[{"decision":"ADMIT","decidedBy":"m1","decidedAt":"2026-01-01T00:00:00.000Z","note":null}]',
      previous_status_before_suspend: null,
      created_at: NOW,
      updated_at: NOW,
    });
    assert.strictEqual(snap.status, 'ADMITTED');
    assert.strictEqual(snap.decisions.length, 1);
    assert.strictEqual(snap.previousStatusBeforeSuspend, null);
  });

  it('面试记录行映射（评价数组与跳过原因）', () => {
    const snap = interviewRowToSnapshot({
      id: 'iv1',
      application_id: 'app1',
      activity_id: 'a1',
      club_id: 'c1',
      round_id: 'r1',
      applicant_id: 'u1',
      status: 'COMPLETED',
      revision_number: 0,
      interviewer_id: 'int1',
      scheduled_at: NOW,
      location: '线上',
      skip_reason: null,
      hold_until: null,
      evaluations:
        '[{"interviewerId":"int1","values":{"score":5},"decidedAt":"2026-01-01T00:00:00.000Z"}]',
      created_at: NOW,
      updated_at: NOW,
    });
    assert.strictEqual(snap.status, 'COMPLETED');
    assert.strictEqual(snap.roundId, 'r1');
    assert.strictEqual(snap.evaluations.length, 1);
    assert.strictEqual(snap.skipReason, null);
  });

  it('补救窗口行映射（kind/目标申请数组/截止）', () => {
    const snap = remedyWindowRowToSnapshot({
      window_id: 'rw1',
      activity_id: 'a1',
      kind: 'PERSONAL_RECOVERY',
      target_application_ids: '["app1","app2"]',
      deadline: NOW,
      reason: '个人恢复',
      created_by: 'm1',
      created_at: NOW,
    });
    assert.strictEqual(snap.windowId, 'rw1');
    assert.strictEqual(snap.kind, 'PERSONAL_RECOVERY');
    assert.deepEqual([...snap.targetApplicationIds], ['app1', 'app2']);
    assert.strictEqual(snap.deadline, NOW);
    assert.strictEqual(snap.createdBy, 'm1');
  });
});

describe('postgres recruitment repository channel SQL（Critical 2 回归防护）', () => {
  const makeFakeDb = () => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const db = {
      beginTransaction: async () => ({ tx: 1 }),
      commit: async () => undefined,
      rollback: async () => undefined,
      setRlsContext: async () => undefined,
      clearRlsContext: async () => undefined,
      query: async <T>(_tx: unknown, sql: string, params: readonly unknown[]): Promise<T[]> => {
        calls.push({ sql, params });
        return [] as T[];
      },
    };
    return { db, calls };
  };

  const channelSnapshot = (overrides: Partial<{ deadline: Date | null }> = {}) => ({
    id: 'ch1',
    activityId: 'a1',
    clubId: 'c1',
    status: 'OPEN',
    openAt: NOW,
    closeAt: null,
    deadline: overrides.deadline ?? null,
    minChoices: 1,
    maxChoices: 2,
    createdAt: NOW,
    updatedAt: NOW,
  });

  it('saveChannel：INSERT 列含 deadline 且参数数组带值；EXCLUDED.deadline 引用合法（曾引未提供列）', async () => {
    const { db, calls } = makeFakeDb();
    const uow = new RecruitmentUnitOfWork(db as never);
    const repo = new PostgresRecruitmentRepository(db as never, uow);
    const deadline = new Date('2026-02-01T00:00:00Z');
    await uow.run({ kind: 'unprotected' }, () =>
      repo.saveChannel(channelSnapshot({ deadline }) as never),
    );
    const insert = calls.find((c) => c.sql.includes('INSERT INTO application_channels'));
    assert.ok(insert, 'saveChannel 必须发出 INSERT');
    // INSERT 列清单必须包含 deadline（EXCLUDED.deadline 的合法性依赖它）
    assert.match(
      insert!.sql,
      /\(id, activity_id, club_id, status, open_at, close_at, deadline, min_choices/,
    );
    assert.match(insert!.sql, /deadline = EXCLUDED\.deadline/);
    // 参数数组长度 = INSERT 列数（11 列），且 deadline 参数存在
    assert.equal(insert!.params.length, 11);
    assert.equal(insert!.params[6] as Date, deadline);
  });

  it('loadChannel：SELECT 列含 deadline（缺列会致 channelRowToSnapshot 读 undefined）', async () => {
    const { db, calls } = makeFakeDb();
    const uow = new RecruitmentUnitOfWork(db as never);
    const repo = new PostgresRecruitmentRepository(db as never, uow);
    await uow.run({ kind: 'unprotected' }, () => repo.loadChannel('ch1'));
    const select = calls.find((c) =>
      c.sql.includes('SELECT id, activity_id, club_id, status, open_at'),
    );
    assert.ok(select, 'loadChannel 必须发出 SELECT');
    assert.match(select!.sql, /open_at, close_at, deadline, min_choices/);
  });

  it('saveRemedyWindow：INSERT 列齐全且含目标申请数组；EXCLUDED 引用合法', async () => {
    const { db, calls } = makeFakeDb();
    const uow = new RecruitmentUnitOfWork(db as never);
    const repo = new PostgresRecruitmentRepository(db as never, uow);
    await uow.run({ kind: 'unprotected' }, () =>
      repo.saveRemedyWindow({
        windowId: 'rw1',
        activityId: 'a1',
        kind: 'PERSONAL_RECOVERY',
        targetApplicationIds: ['app1', 'app2'],
        deadline: NOW,
        reason: '个人恢复',
        createdBy: 'm1',
        createdAt: NOW,
      }),
    );
    const insert = calls.find((c) => c.sql.includes('INSERT INTO remedy_windows'));
    assert.ok(insert, 'saveRemedyWindow 必须发出 INSERT');
    assert.match(
      insert!.sql,
      /\(window_id, activity_id, kind, target_application_ids, deadline, reason, created_by, created_at\)/,
    );
    assert.match(insert!.sql, /target_application_ids = EXCLUDED\.target_application_ids/);
    assert.equal(insert!.params.length, 8);
    // 目标申请数组以 JSONB 字符串序列化入库
    assert.equal(insert!.params[3] as string, JSON.stringify(['app1', 'app2']));
  });

  it('loadRemedyWindow：SELECT 列含 target_application_ids（缺列会致映射读 undefined）', async () => {
    const { db, calls } = makeFakeDb();
    const uow = new RecruitmentUnitOfWork(db as never);
    const repo = new PostgresRecruitmentRepository(db as never, uow);
    await uow.run({ kind: 'unprotected' }, () => repo.loadRemedyWindow('rw1'));
    const select = calls.find((c) =>
      c.sql.includes('SELECT window_id, activity_id, kind, target_application_ids'),
    );
    assert.ok(select, 'loadRemedyWindow 必须发出 SELECT');
    assert.match(select!.sql, /target_application_ids, deadline, reason, created_by, created_at/);
  });
});
