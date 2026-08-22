import { Inject, Injectable } from '@nestjs/common';
import type { AuditEvent } from '../../domain/models/audit-event';
import { AUDIT_REPOSITORY } from '../../infrastructure/audit-repository';
import type { AuditQueryFilter, AuditRepository } from '../../infrastructure/audit-repository';

/** 查询主体验证结果：限制可访问的对象范围（为空表示不限） */
interface ReadScope {
  /** 仅允许查询这些 objectId；为空则不限（超管/本社团负责人/人事） */
  readonly allowedObjectIds?: readonly string[];
}

/** 审计查询主体（AUD-004）：含权限与作用域信息 */
export interface AuditQueryPrincipal {
  readonly principalId: string;
  readonly roles: readonly string[];
  readonly clubId?: string;
  /** 部门负责人可访问的业务对象白名单（由调用方基于业务归属注入） */
  readonly accessibleObjectIds?: readonly string[];
}

/**
 * 审计查询与受控导出（AUD-004 审计中心）。
 *
 * - 支持按时间/用户/社团/对象/事件类型查询与受控导出；
 * - 社团负责人/人事可查导出本社团审计；部门负责人只能看自己有权业务对象的
 *   历史；普通成员/申请人/面试官不看内部审计；超管可查全平台审计且自身
 *   查询也产生审计（占位由 AuditWriter 记录）。
 */
@Injectable()
export class AuditQuery {
  constructor(@Inject(AUDIT_REPOSITORY) private readonly repo: AuditRepository) {}

  async search(
    principal: AuditQueryPrincipal,
    filter: AuditQueryFilter,
  ): Promise<readonly AuditEvent[]> {
    const scope = this.assertCanRead(principal, filter);
    let events = await this.repo.query(filter);
    if (scope.allowedObjectIds !== undefined) {
      // 部门负责人：查询结果强制限定在其对象白名单内（即使 filter.objectId
      // 被篡改为白名单外对象，也拿不到数据，防止横向越权）
      const allowed = new Set(scope.allowedObjectIds);
      events = events.filter((e) => e.target?.objectId !== undefined && allowed.has(e.target.objectId));
    }
    return events;
  }

  /** 查询权限（AUD-004）：超管全平台；负责人/人事本社团；部门负责人仅业务对象；成员/面试官拒绝 */
  private assertCanRead(
    principal: AuditQueryPrincipal,
    filter: AuditQueryFilter,
  ): ReadScope {
    if (principal.roles.includes('SUPER_ADMIN')) {
      return {}; // 超管可查全平台（每次特权访问产生审计由调用方/AuditWriter 记录）
    }
    const isClubHandler = principal.roles.some((r) => r === 'CLUB_LEADER' || r === 'HR_ADMIN');
    if (isClubHandler) {
      if (principal.clubId === undefined) {
        throw new Error('IFC-ERR-003: 本社团负责人/人事须携带社团作用域才能查询审计');
      }
      // 本社团负责人/人事：只能查本社团；未指定 clubId 视为查询本社团
      if (filter.clubId !== undefined && filter.clubId !== principal.clubId) {
        throw new Error('IFC-ERR-003: 只能查询本社团审计');
      }
      if (filter.clubId === undefined) {
        filter = { ...filter, clubId: principal.clubId };
      }
      return {};
    }
    if (principal.roles.includes('DEPARTMENT_LEADER')) {
      // 部门负责人只能看自己有权业务对象的历史：须携带对象白名单，
      // 且查询对象若指定则必须属于该白名单；查询结果由白名单强制过滤，
      // 避免横向越权读取任意对象审计
      const allowed = principal.accessibleObjectIds;
      if (allowed === undefined || allowed.length === 0) {
        throw new Error('IFC-ERR-003: 部门负责人须携带可访问业务对象白名单');
      }
      if (filter.objectId !== undefined && !allowed.includes(filter.objectId)) {
        throw new Error('IFC-ERR-003: 只能查询自己有权访问的业务对象审计');
      }
      return { allowedObjectIds: allowed };
    }
    throw new Error('IFC-ERR-003: 普通成员/申请人/面试官不看内部审计');
  }
}
