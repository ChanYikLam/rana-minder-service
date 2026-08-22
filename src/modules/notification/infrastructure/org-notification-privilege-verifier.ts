/**
 * 组织授权驱动的站内信紧急关闭特权校验（infrastructure；
 * 替换 FailClosedNotificationPrivilegeVerifier）。
 *
 * 语义映射（notification-ports.ts 契约注释；需求 12-数据治理与安全 §3）：
 * - PLATFORM 范围：仅平台超管（isPlatformSuperAdmin，ORG-029）。
 * - CLUB 范围：超管，或该社团管理员（当前有效权限含 `club:member:manage`——
 *   内置负责人/人事模板均含此人事实权限，GOV-007：按已发布模板映射授权，
 *   不按 Group 名派生）。
 *
 * 数据供给：organization 模块导出的 CURRENT_PERMISSIONS_PORT 契约（ORG-038
 * 逐请求重算）；org 基础设施换 PostgreSQL 实现时本适配器自动跟随变真。
 */

import type { CurrentPermissionsPort } from '../../organization/application/ports';
import { PermissionCatalog } from '../../organization/domain/models/permission-template';

import type { NotificationPrivilegeVerifier } from './notification-ports';
import type { KillSwitchScope } from '../domain/models/kill-switch.model';

export class OrgBackedNotificationPrivilegeVerifier implements NotificationPrivilegeVerifier {
  constructor(private readonly permissions: CurrentPermissionsPort) {}

  async canOperateKillSwitch(
    scope: KillSwitchScope,
    clubId: string | null,
    subjectId: string,
  ): Promise<boolean> {
    const isSuperAdmin = await this.permissions.isPlatformSuperAdmin(subjectId);
    if (isSuperAdmin) {
      return true;
    }
    if (scope !== 'CLUB' || clubId === null) {
      return false;
    }
    const effective = await this.permissions.effectiveForClub(subjectId, clubId);
    return effective.includes(PermissionCatalog.CLUB_MEMBER_MANAGE);
  }
}
