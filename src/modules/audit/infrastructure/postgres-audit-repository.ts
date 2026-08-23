/**
 * PostgreSQL 审计权威仓储（infrastructure；AUD-003/004）。
 *
 * 表 audit_event（只追加、不可篡改；与业务同事务提交）。
 *
 * - **只追加、不可篡改**：不提供修改/删除方法；应用内任何管理员不能修改或删除审计。
 * - **同事务**：append 在 AuditUnitOfWork 事务内提交（写入失败业务整体失败，
 *   AUD-003/IFC-TX-006），避免生产关键审计静默丢失。
 * - **敏感不落盘**：only 写入已脱敏摘要（old_value/new_value/sanitized_context），
 *   密码/邮箱密钥/令牌/验证码/附件正文不得进表。
 * - **查询**：按时间/用户/社团/对象/事件类型过滤，`ORDER BY occurred_at DESC LIMIT`
 *   取时间上“最近 N 条”（与 InMemoryAuditRepository 语义一致）。
 */

import type { DbAdapter } from '../../../shared/db-adapter';
import type {
  AuditEvent,
  AuditEventType,
  AuditOutcome,
  AuditSource,
} from '../domain/models/audit-event';
import type { AuditQueryFilter, AuditRepository } from './audit-repository';
import type { AuditUnitOfWork } from './audit-unit-of-work';

/** 将领域事件扁平化为 audit_event 行的列参数 */
interface AuditEventRow {
  readonly audit_id: string;
  readonly event_type: string;
  readonly actor_id: string;
  readonly actor_roles: string;
  readonly scope: string | null;
  readonly occurred_at: Date;
  readonly source: string | null;
  readonly target: string | null;
  readonly old_value: string | null;
  readonly new_value: string | null;
  readonly outcome: string;
  readonly failure_reason: string | null;
  readonly request_id: string;
  readonly sanitized_context: string | null;
}

/** 把行还原为领域事件（JSONB 反序列化） */
interface AuditEventRowOut extends Omit<AuditEventRow, 'actor_roles'> {
  readonly actor_roles: unknown;
}

function toRow(e: AuditEvent): AuditEventRow {
  return {
    audit_id: e.auditId,
    event_type: e.eventType,
    actor_id: e.actorId,
    actor_roles: JSON.stringify(e.actorRoles),
    scope: e.scope === null ? null : JSON.stringify(e.scope),
    occurred_at: new Date(e.occurredAt),
    source: e.source === null ? null : JSON.stringify(e.source),
    target: e.target === null ? null : JSON.stringify(e.target),
    old_value: e.oldValue,
    new_value: e.newValue,
    outcome: e.outcome,
    failure_reason: e.failureReason ?? null,
    request_id: e.requestId,
    sanitized_context: e.sanitizedContext ?? null,
  };
}

function fromRow(r: AuditEventRowOut): AuditEvent {
  return {
    auditId: r.audit_id,
    eventType: r.event_type as AuditEventType,
    actorId: r.actor_id,
    actorRoles: Array.isArray(r.actor_roles) ? (r.actor_roles as readonly string[]) : [],
    scope: r.scope === null ? null : (JSON.parse(r.scope as string) as AuditEvent['scope']),
    occurredAt: (r.occurred_at as Date).toISOString(),
    source:
      r.source === null
        ? { channel: 'SYSTEM_TASK' }
        : (JSON.parse(r.source as string) as AuditSource),
    target: r.target === null ? null : (JSON.parse(r.target as string) as AuditEvent['target']),
    oldValue: r.old_value,
    newValue: r.new_value,
    outcome: r.outcome as AuditOutcome,
    failureReason: r.failure_reason ?? undefined,
    requestId: r.request_id,
    sanitizedContext: r.sanitized_context ?? undefined,
  };
}

export class PostgresAuditRepository implements AuditRepository {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: AuditUnitOfWork,
  ) {}

  /** 只追加写入（与业务同一事务提交；写入失败业务整体失败，AUD-003/IFC-TX-006） */
  async append(event: AuditEvent): Promise<void> {
    const row = toRow(event);
    await this.db.query(
      this.uow.active,
      `INSERT INTO audit_event (
         audit_id, event_type, actor_id, actor_roles, scope, occurred_at, source,
         target, old_value, new_value, outcome, failure_reason, request_id, sanitized_context
       ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8::jsonb,
                 $9, $10, $11, $12, $13, $14)`,
      [
        row.audit_id,
        row.event_type,
        row.actor_id,
        row.actor_roles,
        row.scope,
        row.occurred_at,
        row.source,
        row.target,
        row.old_value,
        row.new_value,
        row.outcome,
        row.failure_reason,
        row.request_id,
        row.sanitized_context,
      ],
    );
  }

  /** 按条件查询（时间/用户/社团/对象/事件类型），ORDER BY occurred_at DESC LIMIT 取最近 N 条 */
  async query(filter: AuditQueryFilter): Promise<readonly AuditEvent[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const limit = filter.limit ?? 100;
    if (limit <= 0) {
      return [];
    }
    if (filter.from !== undefined) {
      params.push(filter.from);
      conditions.push(`occurred_at >= $${params.length}`);
    }
    if (filter.to !== undefined) {
      params.push(filter.to);
      conditions.push(`occurred_at <= $${params.length}`);
    }
    if (filter.actorId !== undefined) {
      params.push(filter.actorId);
      conditions.push(`actor_id = $${params.length}`);
    }
    if (filter.clubId !== undefined) {
      params.push(filter.clubId);
      conditions.push(`scope->>'clubId' = $${params.length}`);
    }
    if (filter.objectType !== undefined) {
      params.push(filter.objectType);
      conditions.push(`target->>'objectType' = $${params.length}`);
    }
    if (filter.objectId !== undefined) {
      params.push(filter.objectId);
      conditions.push(`target->>'objectId' = $${params.length}`);
    }
    if (filter.eventType !== undefined) {
      params.push(filter.eventType);
      conditions.push(`event_type = $${params.length}`);
    }
    params.push(limit);
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = await this.db.query<AuditEventRowOut>(
      this.uow.active,
      `SELECT audit_id, event_type, actor_id, actor_roles, scope, occurred_at, source,
              target, old_value, new_value, outcome, failure_reason, request_id,
              sanitized_context
       FROM audit_event${where}
       ORDER BY occurred_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows.map(fromRow);
  }
}
