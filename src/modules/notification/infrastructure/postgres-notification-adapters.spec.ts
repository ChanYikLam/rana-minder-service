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
  PostgresChannelDeliveryAttemptRepository,
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

  it('updateAttempt：UPDATE 必须落 attempt_number（C2 防回归，退避递增依赖）', async () => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const db = {
      beginTransaction: async () => ({ tx: 1 }),
      commit: async () => undefined,
      rollback: async () => undefined,
      setRlsContext: async () => undefined,
      clearRlsContext: async () => undefined,
      query: async <T>(_tx: unknown, sql: string, params: readonly unknown[]): Promise<T[]> => {
        calls.push({ sql, params });
        if (sql.includes('FROM channel_delivery_attempts WHERE attempt_id')) {
          return [
            {
              attempt_id: 'a1',
              fact_id: 'f1',
              snapshot_id: null,
              recipient_id: null,
              channel: 'EMAIL',
              status: 'FAILED_RETRY',
              attempt_number: 1,
              channel_message_id: null,
              target_address: 'stu@example.com',
              template_version_id: null,
              sender_identity: null,
              email_subject: null,
              email_body: null,
              first_failed_at: null,
              payload: JSON.stringify({
                responseCategory: 'TEMPORARY_FAILURE',
                sanitizedError: null,
                nextRetryAt: null,
                completedAt: null,
                version: 1,
              }),
              created_at: new Date('2026-08-25T00:00:00.000Z'),
            },
          ] as T[];
        }
        return [] as T[];
      },
    };
    const repo = new PostgresChannelDeliveryAttemptRepository(db as never);
    await repo.updateAttempt('a1', {
      status: 'DELIVERED',
      attemptNumber: 2,
      completedAt: '2026-08-25T01:00:00.000Z',
    });
    const upd = calls.find((c) => c.sql.includes('UPDATE channel_delivery_attempts'));
    assert.ok(upd, '必须发出 UPDATE');
    assert.match(upd!.sql, /attempt_number = \$3/, 'UPDATE 必须包含 attempt_number 列（C2）');
    assert.equal(upd!.params.length, 6, '无冗余占位符（I1：$2 冗余已去除）');
    assert.equal(upd!.params[2], 2, 'attempt_number 新值必须落库');
  });

  it('claimForRetry：仅 FAILED_RETRY 可原子抢占为 PENDING（W1 防并发重复发送）', async () => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const db = {
      beginTransaction: async () => ({ tx: 1 }),
      commit: async () => undefined,
      rollback: async () => undefined,
      setRlsContext: async () => undefined,
      clearRlsContext: async () => undefined,
      query: async <T>(_tx: unknown, sql: string, params: readonly unknown[]): Promise<T[]> => {
        calls.push({ sql, params });
        if (
          sql.includes('UPDATE channel_delivery_attempts') &&
          sql.includes("status = 'PENDING'")
        ) {
          return [
            {
              attempt_id: 'a1',
              fact_id: 'f1',
              snapshot_id: null,
              recipient_id: null,
              channel: 'EMAIL',
              status: 'PENDING',
              attempt_number: 1,
              channel_message_id: null,
              target_address: 'stu@example.com',
              template_version_id: null,
              sender_identity: null,
              email_subject: null,
              email_body: null,
              first_failed_at: null,
              payload: JSON.stringify({
                responseCategory: null,
                sanitizedError: null,
                nextRetryAt: null,
                completedAt: null,
                version: 1,
              }),
              created_at: new Date('2026-08-25T00:00:00.000Z'),
            },
          ] as T[];
        }
        return [] as T[];
      },
    };
    const repo = new PostgresChannelDeliveryAttemptRepository(db as never);
    const claimed = await repo.claimForRetry('a1');
    const upd = calls.find((c) => c.sql.includes('UPDATE channel_delivery_attempts'));
    assert.ok(upd, '必须发出抢占 UPDATE');
    assert.match(upd!.sql, /status = 'FAILED_RETRY'/, '抢占条件必须限定 FAILED_RETRY（W1）');
    assert.equal(claimed?.status, 'PENDING');
  });

  it('saveFactWithSnapshots：去重键冲突抛出领域错误（NTF-003 幂等入口）', async () => {
    const db = {
      beginTransaction: async () => ({ tx: 1 }),
      commit: async () => undefined,
      rollback: async () => undefined,
      setRlsContext: async () => undefined,
      clearRlsContext: async () => undefined,
      query: async <T>(_tx: unknown, _sql: string, _params: readonly unknown[]): Promise<T[]> =>
        [{ n: 1 }] as T[],
    };
    const repo = new PostgresNotificationRepository(db as never);
    await assert.rejects(
      repo.saveFactWithSnapshots(
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
        [
          {
            snapshotId: 'snap-1',
            factId: '',
            recipientId: 'stu-1',
            reason: '本人',
            scope: { type: 'PLATFORM', clubId: null },
            dedupKey: 'evt-1:stu-1',
            createdAt: NOW.toISOString(),
          },
        ],
      ),
      /去重键冲突/,
    );
  });

  it('模板快照：CLUB 作用域命中社团模板，PLATFORM 命中平台模板（W2）', async () => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const db = {
      beginTransaction: async () => ({ tx: 1 }),
      commit: async () => undefined,
      rollback: async () => undefined,
      setRlsContext: async () => undefined,
      clearRlsContext: async () => undefined,
      query: async <T>(_tx: unknown, sql: string, params: readonly unknown[]): Promise<T[]> => {
        calls.push({ sql, params });
        if (sql.includes('FROM email_templates')) {
          return [
            {
              template_id: 'tmpl-1',
              scope_type: params[0],
              scope_key: params[1],
              kind: params[2],
              active_version: 3,
              versions: JSON.stringify([
                {
                  templateId: 'tmpl-1',
                  version: 3,
                  subject: 's',
                  htmlBody: '<p>b</p>',
                  createdBy: 'sa',
                  createdAt: NOW.toISOString(),
                  note: 'n',
                },
              ]),
              created_at: NOW,
            },
          ] as T[];
        }
        return [] as T[];
      },
    };
    const store = new PostgresEmailTemplateStore(db as never);
    const svc = new PostgresTemplateSnapshotService(store);
    const clubId = await svc.snapshotTemplate('interview', 'EMAIL', {
      type: 'CLUB',
      clubId: 'club-9',
    });
    const platformId = await svc.snapshotTemplate('interview', 'EMAIL', {
      type: 'PLATFORM',
      clubId: null,
    });
    const clubQuery = calls.find((c) => c.params[0] === 'CLUB');
    const platformQuery = calls.find((c) => c.params[0] === 'PLATFORM');
    assert.ok(clubQuery, 'CLUB 事实必须查询社团模板（W2）');
    assert.equal(clubQuery!.params[1], 'club-9');
    assert.ok(platformQuery, 'PLATFORM 事实必须查询平台模板（scope）');
    assert.equal(platformQuery!.params[1], 'platform');
    assert.equal(clubId, 'tmpl-1:v3');
    assert.equal(platformId, 'tmpl-1:v3');
  });
});
