/**
 * Postgres 通知基础设施单测（4.3 收口；fake DbAdapter + 行映射纯函数）。
 *
 * 覆盖：事实/收件人行映射往返；收件箱呈现行映射；配置 KV 存取（kill_switch）；
 * 模板版本保存/活跃版本快照。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  notificationFactModelToRow,
  notificationFactRowToModel,
  inboxPresentationRowToModel,
  PostgresNotificationRepository,
  PostgresKillSwitchRepository,
  PostgresEmailTemplateStore,
  PostgresTemplateSnapshotService,
} from './postgres-notification-adapters';
import type { NotificationFactModel } from '../domain/models/notification-fact.model';

const NOW = new Date('2026-08-25T00:00:00.000Z');

function makeFact(overrides: Partial<NotificationFactModel> = {}): NotificationFactModel {
  return {
    factId: 'fact-1',
    logicalEventId: 'evt-1',
    sourceObjectId: 'obj-1',
    sourceObjectVersion: 1,
    sourceCommandId: 'cmd-1',
    eventType: 'interview',
    eventTime: NOW.toISOString(),
    status: 'CREATED_PENDING_DELIVERY',
    summary: '你已报名成功',
    targetObjectRef: '/activity/1',
    deadlineAt: null,
    scope: { type: 'CLUB', clubId: 'club-1' },
    createdAt: NOW.toISOString(),
    version: 1,
    ...overrides,
  };
}

/** fake DbAdapter（按 SQL 模式分发） */
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

describe('Postgres 通知基础设施（4.3 收口）', () => {
  it('事实行映射往返：payload 展开保留嵌套字段', () => {
    const fact = makeFact();
    const row = notificationFactModelToRow(fact, ['evt-1:stu-1']);
    const snap = notificationFactRowToModel({
      ...row,
      payload: JSON.stringify(row.payload),
      recipient_snapshots: '[]',
    } as never);
    assert.equal(snap.factId, 'fact-1');
    assert.equal(snap.eventType, 'interview');
    assert.equal(snap.scope.clubId, 'club-1');
    assert.equal(snap.summary, '你已报名成功');
    assert.equal(snap.status, 'CREATED_PENDING_DELIVERY');
  });

  it('呈现行映射：deadlineAt/processedAt 从 payload 还原', () => {
    const snap = inboxPresentationRowToModel({
      presentation_id: 'pres-1',
      fact_id: 'fact-1',
      recipient_id: 'stu-1',
      status: 'READ',
      deadline_status: null,
      event_type: 'interview',
      title: 't',
      body: 'b',
      link: null,
      club_name: null,
      delivered_at: NOW,
      read_at: NOW,
      version: 2,
      payload: JSON.stringify({ deadlineAt: null, processedAt: null, hiddenAt: null }),
    });
    assert.equal(snap.status, 'READ');
    assert.equal(snap.readAt, NOW.toISOString());
    assert.equal(snap.version, 2);
  });

  it('saveFactWithSnapshots：INSERT 事实（事务内）', async () => {
    const { db, calls } = makeFakeDb();
    const repo = new PostgresNotificationRepository(db as never);
    await repo.saveFactWithSnapshots(
      {
        logicalEventId: 'evt-1',
        sourceObjectId: 'obj-1',
        sourceObjectVersion: 1,
        sourceCommandId: 'cmd-1',
        eventType: 'interview',
        eventTime: NOW.toISOString(),
        summary: 's',
        targetObjectRef: null,
        scope: { type: 'PLATFORM', clubId: null },
      },
      [],
    );
    const insert = calls.find((c) => c.sql.includes('INSERT INTO notification_facts'));
    assert.ok(insert, '必须发出 INSERT');
    assert.equal(insert!.params[3], 'interview');
  });

  it('KillSwitch 配置：save → 按 scope 落库（KV kind 隔离）', async () => {
    const { db, calls } = makeFakeDb();
    const repo = new PostgresKillSwitchRepository(db as never);
    await repo.save({
      switchId: 'ks-1',
      scope: 'PLATFORM',
      clubId: null,
      active: true,
      reason: '维护',
      operatorId: 'sa-1',
      operatorName: '超管',
      startedAt: NOW.toISOString(),
      expectedResumeAt: null,
      resumedAt: null,
      resumedBy: null,
      secondaryConfirmation: 'cfm',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    } as never);
    const insert = calls.find((c) => c.sql.includes('INSERT INTO notification_configs'));
    assert.ok(insert, '必须发出 KV INSERT');
    assert.equal(insert!.params[0], 'KILL_SWITCH');
    assert.equal(insert!.params[1], 'PLATFORM:platform');
  });

  it('模板：saveVersion 激活（版本 1 + 快照服务占位兜底）', async () => {
    const { db } = makeFakeDb();
    const store = new PostgresEmailTemplateStore(db as never);
    const model = await store.saveVersion(
      { type: 'PLATFORM' },
      'interview',
      '面试通知',
      '<p>hi</p>',
      'sa-1',
      '初始模板',
    );
    assert.equal(model.activeVersion, 1);
    assert.equal(model.kind, 'interview');
    // fake 无持久化：findActive 返回空 → 快照服务走占位标识（语义：无模板不阻断发送）
    const snapshot = new PostgresTemplateSnapshotService(store);
    const id = await snapshot.snapshotTemplate('interview', 'EMAIL');
    assert.match(id, /^tmpl-interview-/);
  });
});
