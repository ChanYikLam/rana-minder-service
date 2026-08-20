/**
 * 权限模板领域服务（ORG-019/035、GOV-007）。
 *
 * - 内置社团负责人/人事管理员/部门负责人模板（ORG-019）。
 * - 超管可从固定权限项目录配置模板；部门级模板不能突破部门范围、不能授予平台
 *   超管；社团模板不能产生平台超管（ORG-035、GOV-007）。
 * - 发布按"草稿 → 已发布不可变版本"走（DATA-CFG-001），失败保留旧发布版本。
 */

import type { PermissionName, PermissionTemplate } from '../models/permission-template';
import {
  BUILT_IN_TEMPLATES,
  PermissionCatalog,
  departmentTemplateAllowedPermissions,
  sanitizeClubTemplatePermissions,
} from '../models/permission-template';
import { orgError } from '../types';

export interface TemplateDiff {
  readonly added: PermissionName[];
  readonly removed: PermissionName[];
}

function sortedKnownPermissionCatalog(): PermissionName[] {
  return Object.values(PermissionCatalog);
}

export class PermissionTemplateService {
  static builtInTemplates(): PermissionTemplate[] {
    return Object.values(BUILT_IN_TEMPLATES).map((t) => ({
      id: t.id,
      name: t.name,
      scopeClass: t.scopeClass,
      draft: null,
      published: { version: 1, name: t.name, permissions: t.permissions },
      createdAt: '2026-08-01T00:00:00.000Z',
      builtIn: true,
    }));
  }

  static diff(
    oldPermissions: readonly string[],
    draftPermissions: readonly string[],
  ): TemplateDiff {
    const oldSet = new Set(oldPermissions);
    const draftSet = new Set(draftPermissions);
    return {
      added: draftPermissions.filter((p) => !oldSet.has(p)) as PermissionName[],
      removed: oldPermissions.filter((p) => !draftSet.has(p)) as PermissionName[],
    };
  }

  static validateDraftPermissions(
    scopeClass: 'club' | 'department',
    permissions: readonly string[],
  ): PermissionName[] {
    const catalog = new Set(sortedKnownPermissionCatalog());
    const unknown = permissions.filter((p) => !catalog.has(p as PermissionName));
    if (unknown.length > 0) {
      throw orgError.validation(`权限项目录中不存在：${unknown.join(', ')}（ORG-035）`);
    }
    const sanitized =
      scopeClass === 'department'
        ? departmentTemplateAllowedPermissions(permissions)
        : sanitizeClubTemplatePermissions(permissions);
    if (sanitized.length !== permissions.length) {
      throw orgError.validation(
        `模板权限超出${scopeClass === 'department' ? '部门' : '社团'}级别范围（ORG-035、GOV-007）`,
      );
    }
    return permissions as PermissionName[];
  }

  static createTemplateDraft(
    existing: PermissionTemplate | null,
    name: string,
    permissions: readonly PermissionName[],
    at: string,
  ): PermissionTemplate {
    const base: PermissionTemplate = existing ?? {
      id: `ptpl-${at}`,
      name,
      scopeClass: 'club',
      draft: null,
      published: null,
      createdAt: at,
      builtIn: false,
    };
    const draftVersion = (existing?.draft?.version ?? existing?.published?.version ?? 0) + 1;
    return {
      ...base,
      name,
      draft: { version: draftVersion, name, permissions: [...permissions] },
    };
  }
}
