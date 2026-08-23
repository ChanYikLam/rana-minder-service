/**
 * 组织授权驱动的招新授权适配器（infrastructure；替换 NotWiredRecruitmentAuthorization）。
 *
 * 语义映射（ORG-038 逐请求重算；权限名来自 PermissionCatalog，GOV-007 禁止
 * Group 名称派生授权）：
 * - canManageRecruitment：主体在该社团当前有效权限含 `club:recruitment:manage`
 *   （内置负责人模板已含）。
 * - canSubmitApplication：账号有效性由会话链路（API-AUTH-001）保证；此处按
 *   "非该社团现任成员"判定——`primaryRoleAt` 为空即无职位 Group（ORG-021 成员前提
 *   的反向应用）。批次资格快照等业务规则仍由提交用例自行核验。
 *
 * 数据供给：注入 organization 模块导出的 CURRENT_PERMISSIONS_PORT 契约；
 * org 基础设施由内存桩切换为 PostgreSQL 实现时本适配器自动跟随变真，
 * 无需改动 recruitment 模块。
 */

import type { CurrentPermissionsPort } from '../../organization/application/ports';
import { PermissionCatalog } from '../../organization/domain/models/permission-template';

import type {
  RecruitmentAuthorizationInput,
  RecruitmentAuthorizationPort,
} from '../application/ports/recruitment-authorization.port';

export class OrgBackedRecruitmentAuthorization implements RecruitmentAuthorizationPort {
  constructor(private readonly permissions: CurrentPermissionsPort) {}

  async canManageRecruitment(input: RecruitmentAuthorizationInput): Promise<boolean> {
    const effective = await this.permissions.effectiveForClub(input.subjectId, input.clubId);
    return effective.includes(PermissionCatalog.CLUB_RECRUITMENT_MANAGE);
  }

  async canSubmitApplication(input: RecruitmentAuthorizationInput): Promise<boolean> {
    const role = await this.permissions.primaryRoleAt(input.subjectId, input.clubId);
    return role === '';
  }
}
