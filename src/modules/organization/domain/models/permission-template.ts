/**
 * 权限模板模型（ORG-019/035、GOV-007）。
 *
 * - 权限只来自"职位 Group → 已发布权限模板"受控映射加业务临时授权；Group 名称、
 *   客户端角色与历史职位不得授权（GOV-007）。
 * - 内置负责人/人事/部门负责人模板；超管可从固定权限项目录配置模板并映射到职位
 *   Group；部门级模板不得突破部门范围、不得授予平台超管权限（ORG-035）。
 * - 社团管理员不能改模板/映射（ORG-019）。
 * - 采用"草稿 + 已发布不可变版本"模型（DATA-CFG-001）。
 */

import type { GroupStableRef } from '../types';

export type TemplateScopeClass = 'club' | 'department';

/** 固定权限项目录（平台侧常量；组织模块只引用，不定义新权限） */
export const PermissionCatalog = {
  PLATFORM_CLUB_MANAGE: 'platform:club:manage',
  PLATFORM_CONFIG_MANAGE: 'platform:config:manage',
  PLATFORM_DELETE_EXECUTE: 'platform:delete:execute',
  PLATFORM_AUDIT_VIEW: 'platform:audit:view',
  PLATFORM_EXPORT_EXECUTE: 'platform:export:execute',

  CLUB_RECRUITMENT_MANAGE: 'club:recruitment:manage',
  CLUB_JOINT_MANAGE: 'club:joint:manage',
  CLUB_MEMBER_MANAGE: 'club:member:manage',
  CLUB_MEMBER_MANAGE_FULL: 'club:member:manage:full',
  CLUB_APPOINTMENT_MANAGE: 'club:appointment:manage',
  CLUB_RESIGNATION_APPROVE: 'club:resignation:approve',
  CLUB_BATCH_EXECUTE: 'club:batch:execute',
  CLUB_TRANSITION_MANAGE: 'club:transition:manage',
  CLUB_INVITE_MANAGE: 'club:invite:manage',
  CLUB_EXPORT_EXECUTE: 'club:export:execute',
  CLUB_CONFIG_MANAGE: 'club:config:manage',
  CLUB_INTERVIEW_VIEW: 'club:interview:view',
  CLUB_INTERVIEW_EVALUATE: 'club:interview:evaluate',
  CLUB_AUDIT_VIEW: 'club:audit:view',
} as const;

export type PermissionName = (typeof PermissionCatalog)[keyof typeof PermissionCatalog];

export const BUILT_IN_TEMPLATES = {
  /** 社团负责人（ORG-021：可管理人事/部门负责人/普通职位与全社团事务） */
  LEADER: {
    id: 'ptpl-builtin-leader',
    name: '社团负责人',
    scopeClass: 'club' as const,
    permissions: [
      PermissionCatalog.CLUB_RECRUITMENT_MANAGE,
      PermissionCatalog.CLUB_JOINT_MANAGE,
      PermissionCatalog.CLUB_MEMBER_MANAGE,
      PermissionCatalog.CLUB_MEMBER_MANAGE_FULL,
      PermissionCatalog.CLUB_APPOINTMENT_MANAGE,
      PermissionCatalog.CLUB_RESIGNATION_APPROVE,
      PermissionCatalog.CLUB_BATCH_EXECUTE,
      PermissionCatalog.CLUB_TRANSITION_MANAGE,
      PermissionCatalog.CLUB_INVITE_MANAGE,
      PermissionCatalog.CLUB_EXPORT_EXECUTE,
      PermissionCatalog.CLUB_CONFIG_MANAGE,
      PermissionCatalog.CLUB_INTERVIEW_VIEW,
      PermissionCatalog.CLUB_INTERVIEW_EVALUATE,
      PermissionCatalog.CLUB_AUDIT_VIEW,
    ],
  },
  /** 人事管理员（ORG-021：管理部门负责人与普通职位，不能任命/撤销社团负责人） */
  PERSONNEL: {
    id: 'ptpl-builtin-personnel',
    name: '人事管理员',
    scopeClass: 'club' as const,
    permissions: [
      PermissionCatalog.CLUB_MEMBER_MANAGE,
      PermissionCatalog.CLUB_APPOINTMENT_MANAGE,
      PermissionCatalog.CLUB_TRANSITION_MANAGE,
      PermissionCatalog.CLUB_INVITE_MANAGE,
      PermissionCatalog.CLUB_INTERVIEW_VIEW,
      PermissionCatalog.CLUB_INTERVIEW_EVALUATE,
      PermissionCatalog.CLUB_AUDIT_VIEW,
    ],
  },
  /** 部门负责人（ORG-021：仅本部门范围；不得授予社团负责人/人事权限） */
  DEPARTMENT_HEAD: {
    id: 'ptpl-builtin-dept-head',
    name: '部门负责人',
    scopeClass: 'department' as const,
    permissions: [
      PermissionCatalog.CLUB_MEMBER_MANAGE,
      PermissionCatalog.CLUB_INTERVIEW_VIEW,
      PermissionCatalog.CLUB_INTERVIEW_EVALUATE,
    ],
  },
} as const;

const BUILT_IN_PLATFORM_FORBIDDEN = new Set<PermissionName>([
  PermissionCatalog.PLATFORM_CLUB_MANAGE,
  PermissionCatalog.PLATFORM_CONFIG_MANAGE,
  PermissionCatalog.PLATFORM_DELETE_EXECUTE,
  PermissionCatalog.PLATFORM_AUDIT_VIEW,
  PermissionCatalog.PLATFORM_EXPORT_EXECUTE,
]);

/** 部门级模板可配置的权限（ORG-035：不得突破部门范围，仅部门范围的权限） */
const DEPARTMENT_SCOPE_ALLOWED = new Set<PermissionName>([
  PermissionCatalog.CLUB_MEMBER_MANAGE,
  PermissionCatalog.CLUB_INTERVIEW_VIEW,
  PermissionCatalog.CLUB_INTERVIEW_EVALUATE,
]);

export interface PermissionTemplate {
  id: string;
  name: string;
  /** 模板级别：department 模板权限范围始终受所在部门限制（ORG-035） */
  scopeClass: TemplateScopeClass;
  /** 草稿（未发布） */
  draft: { version: number; name: string; permissions: readonly PermissionName[] } | null;
  /** 已发布不可变版本（当前生效） */
  published: {
    version: number;
    name: string;
    permissions: readonly PermissionName[];
  } | null;
  createdAt: string;
  builtIn: boolean;
}

export interface PositionTemplateBinding {
  readonly positionGroup: GroupStableRef;
  readonly clubId: string;
  readonly templateId: string;
  readonly templateVersion: number;
}

/** 部门级模板只能配置部门范围的权限（ORG-035：不得突破部门范围） */
export function departmentTemplateAllowedPermissions(
  permissions: readonly string[],
): readonly string[] {
  return permissions.filter((p) => DEPARTMENT_SCOPE_ALLOWED.has(p as PermissionName));
}

/** 社团级模板不得授予平台超管权限（ORG-035/GOV-007） */
export function sanitizeClubTemplatePermissions(permissions: readonly string[]): readonly string[] {
  return permissions.filter((p) => !BUILT_IN_PLATFORM_FORBIDDEN.has(p as PermissionName));
}
