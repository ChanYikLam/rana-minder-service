/**
 * 组织授权驱动的表单设计权限适配器（infrastructure；替换 NotWiredFormDesignPermission）。
 *
 * 语义映射（FORM-002、GOV-003、ORG-038 逐请求重算；权限名来自 PermissionCatalog）：
 * - platform 作用域：仅平台超管（isPlatformSuperAdmin，ORG-029——超管权限只来自
 *   超管 Group 映射，不来自社团职位模板）。
 * - club 作用域：主体在该社团当前有效权限含任一管理类权限
 *   {recruitment:manage, member:manage, config:manage}，对应端口注释中
 *   "社团负责人/人事管理员可设计本社团报名/成员申请/评价表"。
 * - department 作用域：**保持 fail-closed**。CurrentPermissionsPort 仅提供社团级
 *   聚合，部门级权限解析（ORG-035 部门受限范围）尚无契约支撑；不得因无法核验而
 *   放行（对齐 NotWired 桩的安全立场）。org 暴露部门级查询后替换本分支。
 */

import type { CurrentPermissionsPort } from '../../organization/application/ports';
import { PermissionCatalog } from '../../organization/domain/models/permission-template';

import type {
  FormDesignActor,
  FormDesignPermissionPort,
} from '../application/ports/form-design-permission.port';
import type { FormScope } from '../domain/models/form-scope';

const CLUB_DESIGN_PERMISSIONS: readonly string[] = [
  PermissionCatalog.CLUB_RECRUITMENT_MANAGE,
  PermissionCatalog.CLUB_MEMBER_MANAGE,
  PermissionCatalog.CLUB_CONFIG_MANAGE,
];

export class OrgBackedFormDesignPermission implements FormDesignPermissionPort {
  constructor(private readonly permissions: CurrentPermissionsPort) {}

  async canDesign(actor: FormDesignActor, scope: FormScope): Promise<boolean> {
    if (scope.kind === 'platform') {
      return this.permissions.isPlatformSuperAdmin(actor.subjectId);
    }
    if (scope.ownerId === null) {
      return false;
    }
    if (scope.kind === 'department') {
      // ORG-035：部门级权限解析无契约支撑，fail-closed（不放行、不猜测）。
      return false;
    }
    const effective = await this.permissions.effectiveForClub(
      actor.subjectId,
      scope.ownerId,
    );
    return effective.some((permission) => CLUB_DESIGN_PERMISSIONS.includes(permission));
  }

  async canManagePlatform(actor: FormDesignActor): Promise<boolean> {
    return this.permissions.isPlatformSuperAdmin(actor.subjectId);
  }
}
