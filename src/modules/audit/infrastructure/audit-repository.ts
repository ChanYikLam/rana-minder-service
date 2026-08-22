import { Injectable } from '@nestjs/common';
import type { AuditEvent, AuditEventType } from '../domain/models/audit-event';

/** 审计仓储注入令牌（AuditRepository 为接口，注入须用显式 token） */
export const AUDIT_REPOSITORY = Symbol('AUDIT_REPOSITORY');

/**
 * 审计权威仓储（PostgreSQL 适配；AUD-003/004）。
 *
 * **只追加、不可篡改**：不提供修改/删除方法；应用内任何管理员不能修改或
 * 删除审计；审计长期保留、无应用内删除入口。
 */
export interface AuditRepository {
  /** 只追加写入（与关键业务同一事务提交；写入失败业务整体失败，AUD-003/IFC-TX-006） */
  append(event: AuditEvent): Promise<void>;
  /** 按条件查询（时间/用户/社团/对象/事件类型；受控导出） */
  query(filter: AuditQueryFilter): Promise<readonly AuditEvent[]>;
}

/** 查询过滤条件（AUD-004：按时间/用户/社团/对象/事件类型） */
export interface AuditQueryFilter {
  readonly from?: string;
  readonly to?: string;
  readonly actorId?: string;
  readonly clubId?: string;
  readonly objectType?: string;
  readonly objectId?: string;
  readonly eventType?: AuditEventType;
  readonly limit?: number;
}

/** 进程内实现（开发期占位；只追加不可篡改语义：无修改/删除方法） */
@Injectable()
export class InMemoryAuditRepository implements AuditRepository {
  private readonly events: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }

  async query(filter: AuditQueryFilter): Promise<readonly AuditEvent[]> {
    // limit <= 0 视为不返回任何记录；limit 缺省时取最近 100 条
    const limit = filter.limit ?? 100;
    if (limit <= 0) {
      return [];
    }
    return this.events
      .filter((e) => {
        if (filter.from !== undefined && e.occurredAt < filter.from) return false;
        if (filter.to !== undefined && e.occurredAt > filter.to) return false;
        if (filter.actorId !== undefined && e.actorId !== filter.actorId) return false;
        if (filter.clubId !== undefined && e.scope?.clubId !== filter.clubId) return false;
        if (filter.objectType !== undefined && e.target?.objectType !== filter.objectType)
          return false;
        if (filter.objectId !== undefined && e.target?.objectId !== filter.objectId) return false;
        if (filter.eventType !== undefined && e.eventType !== filter.eventType) return false;
        return true;
      })
      .slice(-limit);
  }
}
