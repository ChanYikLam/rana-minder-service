/**
 * 通知模块 PostgreSQL 基础设施（4.3 收口；12 个 InMemory 桩 → 持久化实现）。
 *
 * 与 PostgresFileRepository 同构：DbAdapter + 独立事务（inTx）+ RLS。
 * 查询列列化（status/scope 等），业务负载 jsonb；行映射纯函数导出便于单测。
 */

import { Injectable } from '@nestjs/common';
import type { DbAdapter, RlsScope, TransactionContext } from '../../../shared/db-adapter';
import { borrowCrossModuleTx } from '../../../shared/cross-module-transaction';
import type {
  NotificationFactModel,
  CreateNotificationFactInput,
} from '../domain/models/notification-fact.model';
import type { RecipientSnapshot } from '../domain/models/recipient-snapshot.model';
import type {
  InboxPresentationModel,
  InboxPresentationStatus,
} from '../domain/models/inbox-presentation.model';
import type { ChannelDeliveryAttemptModel } from '../domain/models/channel-delivery-attempt.model';
import type { KillSwitchStateModel, KillSwitchScope } from '../domain/models/kill-switch.model';
import type {
  EmailTemplateModel,
  EmailTemplateVersion,
  EmailTemplateScope,
} from '../domain/models/email-template';
import type { NotificationKind } from '../../../common/contracts/notifications.contracts';
import type {
  NotificationRepository,
  InboxAdapter,
  InboxListFilter,
  ChannelDeliveryAttemptRepository,
  TemplateSnapshotService,
  KillSwitchRepository,
  PrivilegedAuditWriter,
  PrivilegedAuditEntry,
  EmailConfigStore,
  EmailConfigRecord,
  NotificationPreferencesStore,
  ClubEmailPolicyStore,
  PlatformEmailSuspensionStore,
  EmailTemplateStore,
} from './notification-ports';
import type { ClubEmailPolicy } from '../domain/models/club-email-policy';
import type { PlatformEmailSuspension } from '../domain/models/club-email-policy';

/** 通知域最小 RLS 上下文（首版 unprotected；数据隔离在组织/身份落地后细化） */
export const NOTIFICATION_RLS_SCOPE: RlsScope = { kind: 'unprotected' };

function parseJsonb<T>(value: unknown): T {
  if (typeof value === 'string') {
    return JSON.parse(value) as T;
  }
  return value as T;
}

/** 事实 payload（非查询列字段） */
interface FactPayload {
  readonly sourceObjectId: string;
  readonly sourceObjectVersion: number;
  readonly sourceCommandId: string;
  readonly eventTime: string;
  readonly summary: string;
  readonly targetObjectRef: string | null;
  readonly deadlineAt: string | null;
  readonly scope: NotificationFactModel['scope'];
}

export interface NotificationFactRow {
  fact_id: string;
  dedup_key: string;
  logical_event_id: string;
  event_type: string;
  status: string;
  version: number;
  payload: unknown;
  recipient_snapshots: unknown;
  created_at: Date;
}

export function notificationFactRowToModel(row: NotificationFactRow): NotificationFactModel {
  const p = parseJsonb<FactPayload>(row.payload);
  return {
    factId: row.fact_id,
    logicalEventId: row.logical_event_id,
    sourceObjectId: p.sourceObjectId,
    sourceObjectVersion: p.sourceObjectVersion,
    sourceCommandId: p.sourceCommandId,
    eventType: row.event_type as NotificationFactModel['eventType'],
    eventTime: p.eventTime,
    status: row.status as NotificationFactModel['status'],
    summary: p.summary,
    targetObjectRef: p.targetObjectRef,
    deadlineAt: p.deadlineAt,
    scope: p.scope,
    createdAt: (row.created_at as Date).toISOString(),
    version: Number(row.version),
  };
}

export function notificationFactModelToRow(
  f: NotificationFactModel,
  dedupKeys: readonly string[],
): Omit<NotificationFactRow, 'created_at'> & { created_at: Date } {
  return {
    fact_id: f.factId,
    dedup_key: dedupKeys[0] ?? f.logicalEventId,
    logical_event_id: f.logicalEventId,
    event_type: f.eventType,
    status: f.status,
    version: f.version,
    payload: {
      sourceObjectId: f.sourceObjectId,
      sourceObjectVersion: f.sourceObjectVersion,
      sourceCommandId: f.sourceCommandId,
      eventTime: f.eventTime,
      summary: f.summary,
      targetObjectRef: f.targetObjectRef,
      deadlineAt: f.deadlineAt,
      scope: f.scope,
    } as unknown,
    recipient_snapshots: [] as unknown,
    created_at: new Date(f.createdAt),
  };
}

export interface InboxPresentationRow {
  presentation_id: string;
  fact_id: string;
  recipient_id: string;
  status: string;
  deadline_status: string | null;
  event_type: string;
  title: string;
  body: string;
  link: string | null;
  club_name: string | null;
  delivered_at: Date;
  read_at: Date | null;
  version: number;
  payload: unknown;
}

export function inboxPresentationRowToModel(row: InboxPresentationRow): InboxPresentationModel {
  const p = parseJsonb<{
    deadlineAt: string | null;
    processedAt: string | null;
    hiddenAt: string | null;
  }>(row.payload);
  return {
    presentationId: row.presentation_id,
    factId: row.fact_id,
    recipientId: row.recipient_id,
    status: row.status as InboxPresentationModel['status'],
    deadlineStatus: row.deadline_status as InboxPresentationModel['deadlineStatus'],
    deadlineAt: p.deadlineAt,
    eventType: row.event_type,
    title: row.title,
    body: row.body,
    link: row.link,
    clubName: row.club_name,
    deliveredAt: (row.delivered_at as Date).toISOString(),
    readAt: row.read_at === null ? null : (row.read_at as Date).toISOString(),
    processedAt: p.processedAt,
    hiddenAt: p.hiddenAt,
    version: Number(row.version),
  };
}

/** Postgres 通知仓储（facts + 快照） */
@Injectable()
export class PostgresNotificationRepository implements NotificationRepository {
  constructor(private readonly db: DbAdapter) {}

  private async inTx<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    // 跨模块同事务（IFC-TX-002）：业务方事务窗口内调用时借用其事务——不 begin、
    // 不 commit/rollback、不覆盖外层 RLS 上下文，通知事实随业务原子收口
    const borrowed = borrowCrossModuleTx('notification');
    if (borrowed !== null) {
      return fn(borrowed.tx);
    }
    const tx = await this.db.beginTransaction();
    try {
      await this.db.setRlsContext(tx, NOTIFICATION_RLS_SCOPE);
      const result = await fn(tx);
      await this.db.commit(tx);
      return result;
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }

  async saveFactWithSnapshots(
    input: CreateNotificationFactInput,
    snapshots: readonly RecipientSnapshot[],
  ): Promise<{ fact: NotificationFactModel; snapshots: readonly RecipientSnapshot[] }> {
    return this.inTx(async (tx) => {
      const now = new Date();
      const factId = `fact-${now.getTime()}-${Math.random().toString(36).slice(2, 10)}`;
      // 去重键原子检测（NTF-003）：快照去重键在保存时冲突即抛错（IFC-TX-002）
      for (const s of snapshots) {
        const hit = await this.db.query<{ n: number }>(
          tx,
          `SELECT count(*)::int AS n FROM notification_inbox_presentations
            WHERE fact_id IN (
              SELECT fact_id FROM notification_facts
              WHERE dedup_key = $1
            ) AND recipient_id = $2`,
          [s.dedupKey, s.recipientId],
        );
        if (hit.length > 0 && hit[0].n > 0) {
          throw new Error(`去重键冲突（同一逻辑事件＋收件人已存在）: dedupKey=${s.dedupKey}`);
        }
      }
      const fact: NotificationFactModel = {
        factId,
        logicalEventId: input.logicalEventId,
        sourceObjectId: input.sourceObjectId,
        sourceObjectVersion: input.sourceObjectVersion,
        sourceCommandId: input.sourceCommandId,
        eventType: input.eventType,
        eventTime: input.eventTime,
        status: input.initialStatus ?? 'CREATED_PENDING_DELIVERY',
        summary: input.summary,
        targetObjectRef: input.targetObjectRef,
        deadlineAt: input.deadlineAt ?? null,
        scope: input.scope,
        createdAt: now.toISOString(),
        version: 1,
      };
      const row = notificationFactModelToRow(
        fact,
        snapshots.map((s) => s.dedupKey),
      );
      await this.db.query(
        tx,
        `INSERT INTO notification_facts
           (fact_id, dedup_key, logical_event_id, event_type, status, version, payload, recipient_snapshots, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$9)`,
        [
          row.fact_id,
          row.dedup_key,
          row.logical_event_id,
          row.event_type,
          row.status,
          row.version,
          JSON.stringify(row.payload),
          JSON.stringify(snapshots),
          row.created_at,
        ],
      );
      return { fact, snapshots };
    });
  }

  async findFactByDedupKey(dedupKey: string): Promise<NotificationFactModel | null> {
    return this.inTx(async (tx) => {
      const rows = await this.db.query<NotificationFactRow>(
        tx,
        `SELECT fact_id, dedup_key, logical_event_id, event_type, status, version, payload, recipient_snapshots, created_at
           FROM notification_facts WHERE dedup_key = $1`,
        [dedupKey],
      );
      return rows[0] ? notificationFactRowToModel(rows[0]) : null;
    });
  }

  async findFactById(factId: string): Promise<NotificationFactModel | null> {
    return this.inTx(async (tx) => {
      const rows = await this.db.query<NotificationFactRow>(
        tx,
        `SELECT fact_id, dedup_key, logical_event_id, event_type, status, version, payload, recipient_snapshots, created_at
           FROM notification_facts WHERE fact_id = $1`,
        [factId],
      );
      return rows[0] ? notificationFactRowToModel(rows[0]) : null;
    });
  }

  async updateFactStatus(
    factId: string,
    status: NotificationFactModel['status'],
    expectedVersion: number,
  ): Promise<NotificationFactModel> {
    return this.inTx(async (tx) => {
      const rows = await this.db.query<NotificationFactRow>(
        tx,
        `UPDATE notification_facts SET status = $2, version = version + 1, updated_at = now()
          WHERE fact_id = $1 AND version = $3
          RETURNING fact_id, dedup_key, logical_event_id, event_type, status, version, payload, recipient_snapshots, created_at`,
        [factId, status, expectedVersion],
      );
      if (rows.length === 0) {
        throw new Error('通知事实版本冲突（乐观锁）或不存在');
      }
      return notificationFactRowToModel(rows[0]);
    });
  }

  async findFactsPendingDelivery(limit: number): Promise<readonly NotificationFactModel[]> {
    return this.listFactsByStatus('CREATED_PENDING_DELIVERY', limit, null, null);
  }

  async findFactsPendingDeliveryByKillScope(
    scope: KillSwitchScope,
    clubId: string | null,
    limit: number,
  ): Promise<readonly NotificationFactModel[]> {
    return this.listFactsByStatus('CREATED_PENDING_DELIVERY', limit, scope, clubId);
  }

  async findFactsPausedByKillScope(
    scope: KillSwitchScope,
    clubId: string | null,
    limit: number,
  ): Promise<readonly NotificationFactModel[]> {
    return this.listFactsByStatus('CREATED_PAUSED_DELIVERY', limit, scope, clubId);
  }

  private async listFactsByStatus(
    status: string,
    limit: number,
    scope: KillSwitchScope | null,
    clubId: string | null,
  ): Promise<readonly NotificationFactModel[]> {
    return this.inTx(async (tx) => {
      let where = `status = $1`;
      const params: unknown[] = [status];
      if (scope === 'PLATFORM') {
        where += ` AND payload->'scope'->>'type' = 'PLATFORM'`;
      } else if (scope === 'CLUB' && clubId !== null) {
        params.push(clubId);
        where += ` AND payload->'scope'->>'clubId' = $${params.length}`;
      }
      params.push(limit);
      const rows = await this.db.query<NotificationFactRow>(
        tx,
        `SELECT fact_id, dedup_key, logical_event_id, event_type, status, version, payload, recipient_snapshots, created_at
           FROM notification_facts WHERE ${where}
           ORDER BY created_at LIMIT $${params.length}`,
        params,
      );
      return rows.map(notificationFactRowToModel);
    });
  }

  async findSnapshotsByFactId(factId: string): Promise<readonly RecipientSnapshot[]> {
    return this.inTx(async (tx) => {
      const rows = await this.db.query<{ recipient_snapshots: unknown }>(
        tx,
        `SELECT recipient_snapshots FROM notification_facts WHERE fact_id = $1`,
        [factId],
      );
      return rows.length === 0
        ? []
        : parseJsonb<readonly RecipientSnapshot[]>(rows[0].recipient_snapshots);
    });
  }
}

/** Postgres 站内信收件箱适配器 */
@Injectable()
export class PostgresInboxAdapter implements InboxAdapter {
  constructor(private readonly db: DbAdapter) {}

  private async inTx<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const tx = await this.db.beginTransaction();
    try {
      await this.db.setRlsContext(tx, NOTIFICATION_RLS_SCOPE);
      const result = await fn(tx);
      await this.db.commit(tx);
      return result;
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }

  private static toRow(p: InboxPresentationModel): {
    presentation_id: string;
    fact_id: string;
    recipient_id: string;
    status: string;
    deadline_status: string | null;
    event_type: string;
    title: string;
    body: string;
    link: string | null;
    club_name: string | null;
    delivered_at: Date;
    read_at: Date | null;
    version: number;
    payload: unknown;
  } {
    return {
      presentation_id: p.presentationId,
      fact_id: p.factId,
      recipient_id: p.recipientId,
      status: p.status,
      deadline_status: p.deadlineStatus,
      event_type: p.eventType,
      title: p.title,
      body: p.body,
      link: p.link,
      club_name: p.clubName,
      delivered_at: new Date(p.deliveredAt),
      read_at: p.readAt === null ? null : new Date(p.readAt),
      version: p.version,
      payload: {
        deadlineAt: p.deadlineAt,
        processedAt: p.processedAt,
        hiddenAt: p.hiddenAt,
      },
    };
  }

  async createOrConfirmPresentation(
    fact: NotificationFactModel,
    snapshot: RecipientSnapshot,
  ): Promise<InboxPresentationModel> {
    return this.inTx(async (tx) => {
      const now = new Date().toISOString();
      const model: InboxPresentationModel = {
        presentationId: `pres-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        factId: fact.factId,
        recipientId: snapshot.recipientId,
        status: 'UNREAD',
        deadlineStatus: null,
        deadlineAt: fact.deadlineAt,
        eventType: fact.eventType,
        title: fact.summary,
        body: fact.summary,
        link: fact.targetObjectRef,
        clubName: null,
        deliveredAt: now,
        readAt: null,
        processedAt: null,
        hiddenAt: null,
        version: 1,
      };
      const row = PostgresInboxAdapter.toRow(model);
      await this.db.query(
        tx,
        `INSERT INTO notification_inbox_presentations
           (presentation_id, fact_id, recipient_id, status, deadline_status, event_type, title,
            body, link, club_name, delivered_at, read_at, version, payload, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$11,$11)
         ON CONFLICT (fact_id, recipient_id) DO NOTHING`,
        [
          row.presentation_id,
          row.fact_id,
          row.recipient_id,
          row.status,
          row.deadline_status,
          row.event_type,
          row.title,
          row.body,
          row.link,
          row.club_name,
          row.delivered_at,
          row.read_at,
          row.version,
          JSON.stringify(row.payload),
        ],
      );
      return model;
    });
  }

  async updatePresentationStatus(
    presentationId: string,
    status: InboxPresentationStatus,
    expectedVersion: number,
  ): Promise<InboxPresentationModel> {
    return this.inTx(async (tx) => {
      const rows = await this.db.query<InboxPresentationRow>(
        tx,
        `UPDATE notification_inbox_presentations SET status = $2, version = version + 1, updated_at = now()
          WHERE presentation_id = $1 AND version = $3
          RETURNING presentation_id, fact_id, recipient_id, status, deadline_status, event_type,
                    title, body, link, club_name, delivered_at, read_at, version, payload`,
        [presentationId, status, expectedVersion],
      );
      if (rows.length === 0) {
        throw new Error('站内信呈现版本冲突（乐观锁）或不存在');
      }
      return inboxPresentationRowToModel(rows[0]);
    });
  }

  async markAllRead(recipientId: string): Promise<number> {
    return this.inTx(async (tx) => {
      const rows = await this.db.query<{ n: number }>(
        tx,
        `UPDATE notification_inbox_presentations SET status = 'READ', read_at = now(), updated_at = now()
          WHERE recipient_id = $1 AND status = 'UNREAD' RETURNING presentation_id`,
        [recipientId],
      );
      return rows.length;
    });
  }

  async listForUser(
    recipientId: string,
    filter: InboxListFilter,
    _cursor: string | null,
    limit: number,
  ): Promise<readonly InboxPresentationModel[]> {
    return this.inTx(async (tx) => {
      const params: unknown[] = [recipientId];
      let where = `recipient_id = $1`;
      if (filter.kind !== undefined && filter.kind !== null) {
        params.push(filter.kind);
        where += ` AND event_type = $${params.length}`;
      }
      if (filter.unreadOnly === true) {
        where += ` AND status = 'UNREAD'`;
      }
      if (filter.includeHidden !== true) {
        where += ` AND status <> 'HIDDEN'`;
      }
      params.push(limit);
      const rows = await this.db.query<InboxPresentationRow>(
        tx,
        `SELECT presentation_id, fact_id, recipient_id, status, deadline_status, event_type,
                title, body, link, club_name, delivered_at, read_at, version, payload
           FROM notification_inbox_presentations WHERE ${where}
           ORDER BY delivered_at DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(inboxPresentationRowToModel);
    });
  }

  async countUnread(recipientId: string): Promise<number> {
    return this.inTx(async (tx) => {
      const rows = await this.db.query<{ n: number }>(
        tx,
        `SELECT count(*)::int AS n FROM notification_inbox_presentations
          WHERE recipient_id = $1 AND status = 'UNREAD'`,
        [recipientId],
      );
      return rows.length === 0 ? 0 : rows[0].n;
    });
  }

  async findPresentation(presentationId: string): Promise<InboxPresentationModel | null> {
    return this.inTx(async (tx) => {
      const rows = await this.db.query<InboxPresentationRow>(
        tx,
        `SELECT presentation_id, fact_id, recipient_id, status, deadline_status, event_type,
                title, body, link, club_name, delivered_at, read_at, version, payload
           FROM notification_inbox_presentations WHERE presentation_id = $1`,
        [presentationId],
      );
      return rows[0] ? inboxPresentationRowToModel(rows[0]) : null;
    });
  }
}

/** Postgres 渠道投递尝试仓储 */
export interface AttemptRow {
  attempt_id: string;
  fact_id: string;
  snapshot_id: string | null;
  recipient_id: string | null;
  channel: string;
  status: string;
  attempt_number: number;
  channel_message_id: string | null;
  target_address: string | null;
  template_version_id: string | null;
  sender_identity: string | null;
  email_subject: string | null;
  email_body: string | null;
  first_failed_at: Date | null;
  payload: unknown;
  created_at: Date;
}

export class PostgresChannelDeliveryAttemptRepository implements ChannelDeliveryAttemptRepository {
  constructor(private readonly db: DbAdapter) {}

  private async inTx<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const tx = await this.db.beginTransaction();
    try {
      await this.db.setRlsContext(tx, NOTIFICATION_RLS_SCOPE);
      const result = await fn(tx);
      await this.db.commit(tx);
      return result;
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }

  private static toRow(a: ChannelDeliveryAttemptModel) {
    return {
      attempt_id: a.attemptId,
      fact_id: a.factId,
      snapshot_id: a.snapshotId,
      recipient_id: a.recipientId ?? null,
      channel: a.channel,
      status: a.status,
      attempt_number: a.attemptNumber,
      channel_message_id: a.channelMessageId,
      target_address: a.targetAddress,
      template_version_id: a.templateVersionId,
      sender_identity: a.senderIdentity,
      email_subject: a.emailSubject,
      email_body: a.emailBody,
      first_failed_at: a.firstFailedAt === null ? null : new Date(a.firstFailedAt),
      payload: {
        responseCategory: a.responseCategory,
        sanitizedError: a.sanitizedError,
        nextRetryAt: a.nextRetryAt,
        completedAt: a.completedAt,
        version: a.version,
      },
      created_at: new Date(a.createdAt),
    };
  }

  private static fromRow(row: {
    attempt_id: string;
    fact_id: string;
    snapshot_id: string | null;
    recipient_id: string | null;
    channel: string;
    status: string;
    attempt_number: number;
    channel_message_id: string | null;
    target_address: string | null;
    template_version_id: string | null;
    sender_identity: string | null;
    email_subject: string | null;
    email_body: string | null;
    first_failed_at: Date | null;
    payload: unknown;
    created_at: Date;
  }): ChannelDeliveryAttemptModel {
    const p = parseJsonb<{
      responseCategory: ChannelDeliveryAttemptModel['responseCategory'];
      sanitizedError: string | null;
      nextRetryAt: string | null;
      completedAt: string | null;
      version: number;
    }>(row.payload);
    return {
      attemptId: row.attempt_id,
      factId: row.fact_id,
      snapshotId: row.snapshot_id,
      recipientId: row.recipient_id ?? undefined,
      channel: row.channel as ChannelDeliveryAttemptModel['channel'],
      status: row.status as ChannelDeliveryAttemptModel['status'],
      attemptNumber: Number(row.attempt_number),
      channelMessageId: row.channel_message_id,
      targetAddress: row.target_address,
      templateVersionId: row.template_version_id,
      senderIdentity: row.sender_identity,
      emailSubject: row.email_subject,
      emailBody: row.email_body,
      firstFailedAt:
        row.first_failed_at === null ? null : (row.first_failed_at as Date).toISOString(),
      responseCategory: p.responseCategory,
      sanitizedError: p.sanitizedError,
      nextRetryAt: p.nextRetryAt,
      createdAt: (row.created_at as Date).toISOString(),
      completedAt: p.completedAt,
      version: p.version ?? 1,
    };
  }

  private static SELECT = `SELECT attempt_id, fact_id, snapshot_id, recipient_id, channel, status,
    attempt_number, channel_message_id, target_address, template_version_id, sender_identity,
    email_subject, email_body, first_failed_at, payload, created_at FROM channel_delivery_attempts`;

  async saveAttempt(attempt: ChannelDeliveryAttemptModel): Promise<ChannelDeliveryAttemptModel> {
    return this.inTx(async (tx) => {
      const row = PostgresChannelDeliveryAttemptRepository.toRow(attempt);
      await this.db.query(
        tx,
        `INSERT INTO channel_delivery_attempts
           (attempt_id, fact_id, snapshot_id, recipient_id, channel, status, attempt_number,
            channel_message_id, target_address, template_version_id, sender_identity,
            email_subject, email_body, first_failed_at, payload, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$16)`,
        [
          row.attempt_id,
          row.fact_id,
          row.snapshot_id,
          row.recipient_id,
          row.channel,
          row.status,
          row.attempt_number,
          row.channel_message_id,
          row.target_address,
          row.template_version_id,
          row.sender_identity,
          row.email_subject,
          row.email_body,
          row.first_failed_at,
          JSON.stringify(row.payload),
          row.created_at,
        ],
      );
      return attempt;
    });
  }

  async updateAttempt(
    attemptId: string,
    patch: Partial<ChannelDeliveryAttemptModel>,
  ): Promise<ChannelDeliveryAttemptModel> {
    return this.inTx(async (tx) => {
      const rows = await this.db.query<AttemptRow>(
        tx,
        `${PostgresChannelDeliveryAttemptRepository.SELECT}
           FROM channel_delivery_attempts WHERE attempt_id = $1`,
        [attemptId],
      );
      if (rows.length === 0) {
        throw new Error('渠道投递尝试不存在');
      }
      const current = PostgresChannelDeliveryAttemptRepository.fromRow(rows[0]);
      const merged: ChannelDeliveryAttemptModel = { ...current, ...patch };
      const row = PostgresChannelDeliveryAttemptRepository.toRow(merged);
      // 列全量对齐：attempt_number 必须持久化（重试退避 2^N 依赖其递增，评审 C2）；
      // completedAt/nextRetryAt/responseCategory 等随 payload 整包更新
      await this.db.query(
        tx,
        `UPDATE channel_delivery_attempts SET status = $2, attempt_number = $3,
           channel_message_id = $4, first_failed_at = $5, payload = $6::jsonb, updated_at = now()
          WHERE attempt_id = $1`,
        [
          attemptId,
          row.status,
          row.attempt_number,
          row.channel_message_id,
          row.first_failed_at,
          JSON.stringify(row.payload),
        ],
      );
      return merged;
    });
  }

  async claimForRetry(attemptId: string): Promise<ChannelDeliveryAttemptModel | null> {
    return this.inTx(async (tx) => {
      // 原子抢占：仅 FAILED_RETRY 可被抢占为 PENDING，防止多实例并发重复发送（评审 W1）
      const rows = await this.db.query<AttemptRow>(
        tx,
        `UPDATE channel_delivery_attempts SET status = 'PENDING', updated_at = now()
           WHERE attempt_id = $1 AND status = 'FAILED_RETRY'
           RETURNING attempt_id, fact_id, snapshot_id, recipient_id, channel, status,
             attempt_number, channel_message_id, target_address, template_version_id,
             sender_identity, email_subject, email_body, first_failed_at, payload, created_at`,
        [attemptId],
      );
      return rows.length === 0 ? null : PostgresChannelDeliveryAttemptRepository.fromRow(rows[0]);
    });
  }

  async findRetryableAttempts(limit: number): Promise<readonly ChannelDeliveryAttemptModel[]> {
    return this.inTx(async (tx) => {
      // 含超时恢复：PENDING 超过 30 分钟视为 worker 崩溃遗留，可重新抢占（评审 W1）
      const rows = await this.db.query<AttemptRow>(
        tx,
        `${PostgresChannelDeliveryAttemptRepository.SELECT}
           FROM channel_delivery_attempts
           WHERE status = 'FAILED_RETRY'
              OR (status = 'PENDING' AND updated_at < now() - interval '30 minutes')
           ORDER BY created_at LIMIT $1`,
        [limit],
      );
      return rows.map(PostgresChannelDeliveryAttemptRepository.fromRow);
    });
  }

  async findAttemptById(attemptId: string): Promise<ChannelDeliveryAttemptModel | null> {
    return this.inTx(async (tx) => {
      const rows = await this.db.query<AttemptRow>(
        tx,
        `${PostgresChannelDeliveryAttemptRepository.SELECT}
           FROM channel_delivery_attempts WHERE attempt_id = $1`,
        [attemptId],
      );
      return rows[0] ? PostgresChannelDeliveryAttemptRepository.fromRow(rows[0]) : null;
    });
  }

  async findRecentEmailAttempts(limit: number): Promise<readonly ChannelDeliveryAttemptModel[]> {
    return this.inTx(async (tx) => {
      const rows = await this.db.query<AttemptRow>(
        tx,
        `${PostgresChannelDeliveryAttemptRepository.SELECT}
           FROM channel_delivery_attempts WHERE channel = 'EMAIL'
           ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      return rows.map(PostgresChannelDeliveryAttemptRepository.fromRow);
    });
  }
}

/** Postgres 邮件模板仓储（作用域+类型唯一；版本快照 jsonb，NTF-005） */
export interface EmailTemplateRow {
  template_id: string;
  scope_type: string;
  scope_key: string;
  kind: string;
  active_version: number;
  versions: unknown;
  created_at: Date;
}

export class PostgresEmailTemplateStore implements EmailTemplateStore {
  constructor(private readonly db: DbAdapter) {}

  private async inTx<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const tx = await this.db.beginTransaction();
    try {
      await this.db.setRlsContext(tx, NOTIFICATION_RLS_SCOPE);
      const result = await fn(tx);
      await this.db.commit(tx);
      return result;
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }

  private static scopeKey(scope: EmailTemplateScope): { type: string; key: string } {
    if (scope.type === 'PLATFORM') return { type: 'PLATFORM', key: 'platform' };
    return { type: 'CLUB', key: scope.clubId };
  }

  private static toModel(row: {
    template_id: string;
    scope_type: string;
    scope_key: string;
    kind: string;
    active_version: number;
    versions: unknown;
    created_at: Date;
  }): EmailTemplateModel {
    const versions = parseJsonb<readonly EmailTemplateVersion[]>(row.versions);
    const active = versions.find((v) => v.version === Number(row.active_version)) ?? null;
    return {
      templateId: row.template_id,
      kind: row.kind as NotificationKind,
      scope:
        row.scope_type === 'PLATFORM'
          ? { type: 'PLATFORM' as const }
          : { type: 'CLUB' as const, clubId: row.scope_key },
      subject: active?.subject ?? '',
      htmlBody: active?.htmlBody ?? '',
      activeVersion: Number(row.active_version),
      updatedBy: active?.createdBy ?? null,
      updatedAt: active?.createdAt ?? null,
    };
  }

  async findActive(
    scope: EmailTemplateScope,
    kind: NotificationKind,
  ): Promise<EmailTemplateModel | null> {
    const { type, key } = PostgresEmailTemplateStore.scopeKey(scope);
    return this.inTx(async (tx) => {
      const rows = await this.db.query<EmailTemplateRow>(
        tx,
        `SELECT template_id, scope_type, scope_key, kind, active_version, versions, created_at
           FROM email_templates WHERE scope_type = $1 AND scope_key = $2 AND kind = $3`,
        [type, key, kind],
      );
      return rows[0] ? PostgresEmailTemplateStore.toModel(rows[0]) : null;
    });
  }

  async saveVersion(
    scope: EmailTemplateScope,
    kind: NotificationKind,
    subject: string,
    htmlBody: string,
    savedBy: string,
    note: string,
  ): Promise<EmailTemplateModel> {
    const { type, key } = PostgresEmailTemplateStore.scopeKey(scope);
    return this.inTx(async (tx) => {
      // 行锁防并发版本号重复（评审 I8）：同一作用域×类型同时保存时串行化
      const existing = await this.db.query<EmailTemplateRow>(
        tx,
        `SELECT template_id, scope_type, scope_key, kind, active_version, versions, created_at
           FROM email_templates WHERE scope_type = $1 AND scope_key = $2 AND kind = $3
           FOR UPDATE`,
        [type, key, kind],
      );
      const now = new Date().toISOString();
      const templateId =
        existing.length > 0
          ? (existing[0].template_id as string)
          : `tmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const versions: readonly EmailTemplateVersion[] =
        existing.length > 0
          ? parseJsonb<readonly EmailTemplateVersion[]>(existing[0].versions)
          : [];
      const nextVersion =
        versions.length === 0 ? 1 : Math.max(...versions.map((v) => v.version)) + 1;
      const newVersions: readonly EmailTemplateVersion[] = [
        ...versions,
        {
          templateId,
          version: nextVersion,
          subject,
          htmlBody,
          createdBy: savedBy,
          createdAt: now,
          note,
        },
      ];
      await this.db.query(
        tx,
        `INSERT INTO email_templates (template_id, scope_type, scope_key, kind, active_version, versions, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$7)
         ON CONFLICT (scope_type, scope_key, kind) DO UPDATE SET
           active_version = EXCLUDED.active_version, versions = EXCLUDED.versions, updated_at = EXCLUDED.updated_at`,
        [templateId, type, key, kind, nextVersion, JSON.stringify(newVersions), new Date(now)],
      );
      return PostgresEmailTemplateStore.toModel({
        template_id: templateId,
        scope_type: type,
        scope_key: key,
        kind,
        active_version: nextVersion,
        versions: newVersions as unknown,
        created_at: new Date(now),
      });
    });
  }

  async listVersions(templateId: string): Promise<readonly EmailTemplateVersion[]> {
    return this.inTx(async (tx) => {
      const rows = await this.db.query<{ versions: unknown }>(
        tx,
        `SELECT versions FROM email_templates WHERE template_id = $1`,
        [templateId],
      );
      if (rows.length === 0) return [];
      const versions = parseJsonb<readonly EmailTemplateVersion[]>(rows[0].versions);
      return [...versions].sort((a, b) => b.version - a.version);
    });
  }

  async rollbackToVersion(
    templateId: string,
    version: number,
    rolledBackBy: string,
  ): Promise<EmailTemplateModel> {
    return this.inTx(async (tx) => {
      // 行锁防并发回滚产生重复版本号（评审 I8）
      const rows = await this.db.query<EmailTemplateRow>(
        tx,
        `SELECT template_id, scope_type, scope_key, kind, active_version, versions, created_at
           FROM email_templates WHERE template_id = $1
           FOR UPDATE`,
        [templateId],
      );
      if (rows.length === 0) {
        throw new Error('模板不存在，无法回滚');
      }
      const versions = parseJsonb<readonly EmailTemplateVersion[]>(rows[0].versions);
      const target = versions.find((v) => v.version === version);
      if (target === undefined) {
        throw new Error(`模板版本 ${version} 不存在，无法回滚`);
      }
      const now = new Date().toISOString();
      const newVersions: readonly EmailTemplateVersion[] = [
        ...versions,
        {
          templateId,
          version: Math.max(...versions.map((v) => v.version)) + 1,
          subject: target.subject,
          htmlBody: target.htmlBody,
          createdBy: rolledBackBy,
          createdAt: now,
          note: `回滚到版本 ${version}`,
        },
      ];
      await this.db.query(
        tx,
        `UPDATE email_templates SET active_version = $2, versions = $3::jsonb, updated_at = now()
          WHERE template_id = $1`,
        [templateId, newVersions[newVersions.length - 1].version, JSON.stringify(newVersions)],
      );
      return PostgresEmailTemplateStore.toModel({
        template_id: templateId,
        scope_type: rows[0].scope_type,
        scope_key: rows[0].scope_key,
        kind: rows[0].kind,
        active_version: newVersions[newVersions.length - 1].version,
        versions: newVersions as unknown,
        created_at: rows[0].created_at,
      });
    });
  }

  async deleteClubTemplate(clubId: string, kind: NotificationKind): Promise<boolean> {
    return this.inTx(async (tx) => {
      const rows = await this.db.query<{ id: string }>(
        tx,
        `DELETE FROM email_templates WHERE scope_type = 'CLUB' AND scope_key = $1 AND kind = $2
          RETURNING template_id`,
        [clubId, kind],
      );
      return rows.length > 0;
    });
  }
}

/** Postgres 模板版本快照服务（按模板活跃版本冻结） */
@Injectable()
export class PostgresTemplateSnapshotService implements TemplateSnapshotService {
  constructor(private readonly templates: PostgresEmailTemplateStore) {}

  async snapshotTemplate(
    kind: string,
    _channel: 'INBOX' | 'EMAIL',
    scope?: { readonly type: string; readonly clubId: string | null },
  ): Promise<string> {
    // 按事实作用域选择模板（评审 W2）：CLUB 命中社团模板；PLATFORM/JOINT 回退平台模板
    const target: EmailTemplateScope =
      scope !== undefined && scope.type === 'CLUB' && scope.clubId != null
        ? { type: 'CLUB', clubId: scope.clubId }
        : { type: 'PLATFORM' };
    const active = await this.templates.findActive(target, kind as NotificationKind);
    if (active === null) {
      // 无活跃模板：生成占位快照标识（邮件发送仍可进行，正文由调用方最少摘要兜底）
      return `tmpl-${kind}-${Date.now()}`;
    }
    return `${active.templateId}:v${active.activeVersion}`;
  }
}

/** 统一 KV 配置存取（kill_switch/email_config/preferences/club_policy/platform_suspension） */
class PostgresConfigStore {
  constructor(protected readonly db: DbAdapter) {}

  protected async inTx<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    // 跨模块同事务：借用语义同 PostgresNotificationRepository.inTx（kill-switch 等
    // KV 读随业务事务可见，避免外层未提交状态读不到的幻影）
    const borrowed = borrowCrossModuleTx('notification');
    if (borrowed !== null) {
      return fn(borrowed.tx);
    }
    const tx = await this.db.beginTransaction();
    try {
      await this.db.setRlsContext(tx, NOTIFICATION_RLS_SCOPE);
      const result = await fn(tx);
      await this.db.commit(tx);
      return result;
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }

  protected async load<T>(kind: string, key: string): Promise<T | null> {
    return this.inTx(async (tx) => {
      const rows = await this.db.query<{ value: unknown }>(
        tx,
        `SELECT value FROM notification_configs WHERE config_kind = $1 AND config_key = $2`,
        [kind, key],
      );
      return rows.length === 0 ? null : parseJsonb<T>(rows[0].value);
    });
  }

  protected async store(kind: string, key: string, value: unknown): Promise<void> {
    return this.inTx(async (tx) => {
      await this.db.query(
        tx,
        `INSERT INTO notification_configs (config_kind, config_key, value, updated_at)
         VALUES ($1,$2,$3::jsonb,$4)
         ON CONFLICT (config_kind, config_key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [kind, key, JSON.stringify(value), new Date()],
      );
    });
  }
}

/** Postgres 紧急关闭仓储（SRS-FAIL-009） */
@Injectable()
export class PostgresKillSwitchRepository
  extends PostgresConfigStore
  implements KillSwitchRepository
{
  async save(state: KillSwitchStateModel): Promise<KillSwitchStateModel> {
    await this.store('KILL_SWITCH', `${state.scope}:${state.clubId ?? 'platform'}`, state);
    return state;
  }
  async findByScope(
    scope: KillSwitchScope,
    clubId: string | null,
  ): Promise<KillSwitchStateModel | null> {
    return this.load('KILL_SWITCH', `${scope}:${clubId ?? 'platform'}`);
  }
  async findById(switchId: string): Promise<KillSwitchStateModel | null> {
    const all = await this.inTx(async (tx) => {
      const rows = await this.db.query<{ value: unknown }>(
        tx,
        `SELECT value FROM notification_configs WHERE config_kind = 'KILL_SWITCH'`,
        [],
      );
      return rows.map((r) => parseJsonb<KillSwitchStateModel>(r.value));
    });
    return all.find((s) => s.switchId === switchId) ?? null;
  }
}

/** Postgres 邮件配置存储（§14.4；密钥密文落库不明文） */
@Injectable()
export class PostgresEmailConfigStore extends PostgresConfigStore implements EmailConfigStore {
  async findByClub(clubId: string): Promise<EmailConfigRecord | null> {
    return this.load('EMAIL_CONFIG', clubId);
  }
  async save(config: EmailConfigRecord): Promise<EmailConfigRecord> {
    await this.store('EMAIL_CONFIG', config.clubId, config);
    return config;
  }
}

/** Postgres 通知偏好存储（§7） */
@Injectable()
export class PostgresNotificationPreferencesStore
  extends PostgresConfigStore
  implements NotificationPreferencesStore
{
  async get(
    userId: string,
  ): Promise<{ preferences: Record<string, boolean>; savedAt: string } | null> {
    return this.load('PREFERENCES', userId);
  }
  async set(userId: string, preferences: Record<string, boolean>): Promise<{ savedAt: string }> {
    const savedAt = new Date().toISOString();
    await this.store('PREFERENCES', userId, { preferences, savedAt });
    return { savedAt };
  }
}

/** Postgres 社团邮件策略存储（NTF-004） */
@Injectable()
export class PostgresClubEmailPolicyStore
  extends PostgresConfigStore
  implements ClubEmailPolicyStore
{
  async findByClub(clubId: string): Promise<ClubEmailPolicy | null> {
    return this.load('CLUB_EMAIL_POLICY', clubId);
  }
  async save(policy: ClubEmailPolicy): Promise<ClubEmailPolicy> {
    await this.store('CLUB_EMAIL_POLICY', policy.clubId, policy);
    return policy;
  }
}

/** Postgres 平台邮件停用目录（NTF-004.3） */
@Injectable()
export class PostgresPlatformEmailSuspensionStore
  extends PostgresConfigStore
  implements PlatformEmailSuspensionStore
{
  async get(): Promise<PlatformEmailSuspension> {
    return (
      (await this.load<PlatformEmailSuspension>('PLATFORM_EMAIL_SUSPENSION', 'platform')) ?? {}
    );
  }
  async set(suspension: PlatformEmailSuspension): Promise<void> {
    await this.store('PLATFORM_EMAIL_SUSPENSION', 'platform', suspension);
  }
}

/** Postgres 特权审计写入（需求发现 08：紧急关闭必须写入特权审计） */
@Injectable()
export class PostgresPrivilegedAuditWriter implements PrivilegedAuditWriter {
  constructor(private readonly db: DbAdapter) {}

  async write(entry: PrivilegedAuditEntry): Promise<string> {
    const id = `aud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tx = await this.db.beginTransaction();
    try {
      await this.db.setRlsContext(tx, NOTIFICATION_RLS_SCOPE);
      await this.db.query(
        tx,
        `INSERT INTO notification_privileged_audit
           (id, actor_id, actor_name, action, scope, target_type, target_id, reason, detail, trace_id, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
        [
          id,
          entry.actorId,
          entry.actorName,
          entry.action,
          entry.scope,
          entry.targetType,
          entry.targetId,
          entry.reason,
          JSON.stringify(entry.detail),
          entry.traceId,
          new Date(entry.occurredAt),
        ],
      );
      await this.db.commit(tx);
      return id;
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }
}
