/**
 * 组织授权驱动的 config 授权/成员资格适配器（infrastructure；CFG-001）。
 *
 * 语义映射（ORG-038 逐请求重算；权限名来自 PermissionCatalog，GOV-007 禁止
 * Group 名称派生授权）：
 * - canManageAs：平台超管 → 'PLATFORM'（代改，onBehalf=true）；该社团当前有效
 *   权限含 `club:config:manage`（内置负责人模板已含，人事模板按需配置）→ 'OWNER'；
 *   否则 null（fail-closed）。管理身份由用例推导 onBehalf 留痕语义。
 * - isMember：`primaryRoleAt` 非空即成员——ORG-021「成员前提」的反向应用（同
 *   recruitment canSubmitApplication：职位 Group 判定法；普通无职位成员的 Group
 *   化归组织模块后续切片收口）。
 *
 * 数据供给：注入 organization 模块导出的 CURRENT_PERMISSIONS_PORT 契约；org 基础
 * 设施由内存桩切换为 PostgreSQL 实现时本适配器自动跟随变真，无需改动 config 模块。
 */

import type { CurrentPermissionsPort } from '../../organization/application/ports';
import { PermissionCatalog } from '../../organization/domain/models/permission-template';

import type {
  ClubAccessInfoPort,
  ClubProfileAuthorizationPort,
  ClubMembershipPort,
  ClubProfileManageRole,
} from '../application/ports';

export class OrgBackedConfigAuthorization implements ClubProfileAuthorizationPort {
  constructor(private readonly permissions: CurrentPermissionsPort) {}

  async canManageAs(clubId: string, subjectId: string): Promise<ClubProfileManageRole | null> {
    if (await this.permissions.isPlatformSuperAdmin(subjectId)) {
      return 'PLATFORM';
    }
    const effective = await this.permissions.effectiveForClub(subjectId, clubId);
    if (effective.includes(PermissionCatalog.CLUB_CONFIG_MANAGE)) {
      return 'OWNER';
    }
    return null;
  }
}

export class OrgBackedClubMembership implements ClubMembershipPort {
  constructor(private readonly permissions: CurrentPermissionsPort) {}

  async isMember(clubId: string, subjectId: string): Promise<boolean> {
    // ORG-021 反向应用：primaryRoleAt 为空即无职位 Group → 视为非成员
    const role = await this.permissions.primaryRoleAt(subjectId, clubId);
    return role !== '';
  }
}

/**
 * 接入信息对应关系未接线桩（CFG-001：超管后台「展示名↔Group 名」对照）。
 * 组织模块暴露社团-Casdoor Group 绑定查询端口前恒返回 null；届时替换绑定，
 * config 模块其余部分不变。
 */
export class NotWiredClubAccessInfoPort implements ClubAccessInfoPort {
  async getAccessInfo(_clubId: string): Promise<{
    casdoorGroupId: string;
    casdoorGroupName: string;
  } | null> {
    return null;
  }
}
