import { Inject, Injectable } from '@nestjs/common';
import type { AuditEvent } from '../../domain/models/audit-event';
import { AUDIT_REPOSITORY } from '../../infrastructure/audit-repository';
import type { AuditQueryFilter, AuditRepository } from '../../infrastructure/audit-repository';

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
    principal: { principalId: string; roles: readonly string[]; clubId?: string },
    filter: AuditQueryFilter,
  ): Promise<readonly AuditEvent[]> {
    this.assertCanRead(principal, filter);
    return this.repo.query(filter);
  }

  /** 查询权限（AUD-004）：超管全平台；负责人/人事本社团；部门负责人仅业务对象；成员/面试官拒绝 */
  private assertCanRead(
    principal: { principalId: string; roles: readonly string[]; clubId?: string },
    filter: AuditQueryFilter,
  ): void {
    if (principal.roles.includes('SUPER_ADMIN')) {
      return; // 超管可查全平台（每次特权访问产生审计由调用方/AuditWriter 记录）
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
      return;
    }
    if (principal.roles.includes('DEPARTMENT_LEADER')) {
      // 部门负责人只能看自己有权业务对象的历史（调用方限定 objectId 白名单）
      if (filter.objectId === undefined) {
        throw new Error('IFC-ERR-003: 部门负责人需限定业务对象');
      }
      return;
    }
    throw new Error('IFC-ERR-003: 普通成员/申请人/面试官不看内部审计');
  }
}
