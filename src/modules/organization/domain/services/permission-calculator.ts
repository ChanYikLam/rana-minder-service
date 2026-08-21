/**
 * 当前权限计算（领域服务）。
 *
 * 入口事实（ORG-038、CAS-GEN-002/004、CAS-REC-004）：权限不信任前端角色/作用域，
 * 逐请求按"当前 Casdoor Group 事实 + 本地已发布权限模板映射 + 业务任务授时权限 +
 * 对象状态 + RLS 作用域"重算。
 *
 * 规则：同社团多职位权限取并集（ORG-023）；不同社团严格隔离（ORG-023）；
 * 部门级模板权限范围始终受所在部门限制（ORG-035）；平台超管权限仅来自超管 Group
 * 映射（ORG-029），社团级模板不得产生（GOV-007）。
 */

import type { GroupStableRef } from '../types';
import {
  BUILT_IN_TEMPLATES,
  PermissionCatalog,
  type PermissionName,
  type PositionTemplateBinding,
} from '../models/permission-template';

export interface PermissionSource {
  readonly permission: PermissionName;
  readonly viaPositionGroup: GroupStableRef;
  /** 权限作用域：'platform' | 'club' | 'department' */
  readonly scope: 'platform' | 'club' | 'department';
  readonly scopeId: string;
}

export interface PermissionContext {
  readonly userId: string;
  /** 该用户当前所属职位 Group（门控：必须先在社团 Group 内，ORG-021 成员前提） */
  readonly positionGroups: ReadonlyArray<{
    group: GroupStableRef;
    clubId: string;
    departmentId: string | null;
  }>;
  /** 已发布模板绑定：positionGroup -> template */
  readonly bindings: ReadonlyArray<PositionTemplateBinding>;
  /** 业务任务临时授时权限（面试官等；任务结束自动回收，ORG-035） */
  readonly businessGrants: ReadonlyArray<{
    permission: PermissionName;
    clubId: string;
    departmentId: string | null;
  }>;
  /** 平台超管映射校验结果（ORG-029） */
  readonly isPlatformSuperAdmin: boolean;
}

export interface EffectivePermissions {
  readonly permissions: PermissionName[];
  readonly sources: PermissionSource[];
}

const union = (a: readonly PermissionName[]): PermissionName[] => Array.from(new Set(a));

/** 模板解析器：按模板 id + 版本解析出可授予的权限（内置 + 自定义已发布模板） */
export type TemplateResolver = (
  templateId: string,
  version: number,
) => { scopeClass: 'club' | 'department'; permissions: readonly PermissionName[] } | null;

function resolveBuiltInTemplate(
  templateId: string,
  _version: number,
): { scopeClass: 'club' | 'department'; permissions: readonly PermissionName[] } | null {
  const builtIn = Object.values(BUILT_IN_TEMPLATES).find((t) => t.id === templateId);
  if (builtIn) return { scopeClass: builtIn.scopeClass, permissions: builtIn.permissions };
  return null;
}

export class PermissionCalculator {
  /**
   * 模板解析器默认只解析内置模板；接入方注入自定义模板解析（含已发布自定义模板）
   * 后即可解析任意模板绑定（GOV-007：未映射已发布模板不授权）。
   */
  private readonly resolveTemplate: TemplateResolver;

  constructor(resolveTemplate: TemplateResolver = resolveBuiltInTemplate) {
    this.resolveTemplate = resolveTemplate;
  }

  /**
   * 计算用户在某社团的当前有效权限（跨社团隔离：只计算传入 clubId 内）。
   * platform 权限独立通道返回，不随社团混入。
   */
  calculate(ctx: PermissionContext, clubId: string): EffectivePermissions {
    const sources: PermissionSource[] = [];
    const inClubPositions = ctx.positionGroups.filter((p) => p.clubId === clubId);

    for (const pos of inClubPositions) {
      const binding = ctx.bindings.find(
        (b) =>
          b.clubId === clubId &&
          b.positionGroup.owner === pos.group.owner &&
          b.positionGroup.name === pos.group.name,
      );
      if (!binding) continue; // 职位 Group 未映射已发布模板不授权（GOV-007）
      const template = this.resolveTemplate(binding.templateId, binding.templateVersion);
      if (template === null) continue;
      for (const permission of template.permissions) {
        const scope: 'club' | 'department' =
          template.scopeClass === 'department' ? 'department' : 'club';
        const scopeId = scope === 'department' ? (pos.departmentId ?? '') : clubId;
        // 部门级模板权限范围始终受所在部门限制，不得通过业务授权突破（ORG-035）
        sources.push({ permission, viaPositionGroup: pos.group, scope, scopeId });
      }
    }

    for (const grant of ctx.businessGrants) {
      if (grant.clubId !== clubId) continue;
      const scope = grant.departmentId === null ? 'club' : 'department';
      const scopeId = grant.departmentId ?? clubId;
      sources.push({
        permission: grant.permission,
        viaPositionGroup: { owner: '_task', name: `grant:${grant.permission}` },
        scope,
        scopeId,
      });
    }

    const permissions = union(sources.map((s) => s.permission));
    return { permissions, sources };
  }

  /** 平台级权限（超管通道，ORG-029；仅来自独立超管映射） */
  platformPermissions(ctx: PermissionContext): PermissionName[] {
    if (!ctx.isPlatformSuperAdmin) return [];
    return [
      PermissionCatalog.PLATFORM_CLUB_MANAGE,
      PermissionCatalog.PLATFORM_CONFIG_MANAGE,
      PermissionCatalog.PLATFORM_DELETE_EXECUTE,
      PermissionCatalog.PLATFORM_AUDIT_VIEW,
      PermissionCatalog.PLATFORM_EXPORT_EXECUTE,
    ] as PermissionName[];
  }
}
