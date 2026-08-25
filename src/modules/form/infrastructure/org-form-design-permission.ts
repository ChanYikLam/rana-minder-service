/**
 * 组织授权驱动的表单设计权限适配器（infrastructure；替换 NotWiredFormDesignPermission）。
 *
 * 语义映射（FORM-002、GOV-003、ORG-038 逐请求重算；权限名来自 PermissionCatalog）：
 * - platform 作用域：仅平台超管（isPlatformSuperAdmin，ORG-029——超管权限只来自
 *   超管 Group 映射，不来自社团职位模板）。
 * - club 作用域：主体在该社团当前有效权限含任一管理类权限
 *   {recruitment:manage, member:manage, config:manage}，对应端口注释中
 *   "社团负责人/人事管理员可设计本社团报名/成员申请/评价表"。
 * - department 作用域：主体在该部门的当前有效权限（ORG-035 部门受限范围，
 *   4.1 部门权限契约——effectiveForDepartment）含部门设计权限
 *   {member:manage}（部门负责人唯一管理类权限，DEPARTMENT_HEAD 模板）。
 *   部门权限只来自部门职位，不得用社团级权限放行部门表单（ORG-035 范围限制）。
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

/** 部门设计权限（ORG-035：仅部门受限范围；部门负责人唯一管理类权限） */
const DEPARTMENT_DESIGN_PERMISSIONS: readonly string[] = [
  PermissionCatalog.CLUB_MEMBER_MANAGE,
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
      // ORG-035：部门受限范围权限（4.1 部门权限契约）；ownerId 为部门稳定标识
      const effective = await this.permissions.effectiveForDepartment(
        actor.subjectId,
        scope.ownerId,
      );
      return effective.some((permission) => DEPARTMENT_DESIGN_PERMISSIONS.includes(permission));
    }
    const effective = await this.permissions.effectiveForClub(actor.subjectId, scope.ownerId);
    return effective.some((permission) => CLUB_DESIGN_PERMISSIONS.includes(permission));
  }

  async canManagePlatform(actor: FormDesignActor): Promise<boolean> {
    return this.permissions.isPlatformSuperAdmin(actor.subjectId);
  }
}
