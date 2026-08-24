/**
 * 查询：权限模板（§15.3 GET /api/admin/config/permission-templates*）。
 *
 * 只读查询（列表 + 草稿差异预览）；写操作（新建/保存草稿/发布）见
 * commands/permission-template.command.ts（CQRS：查询只读，命令承载变更）。
 */

import type { PermissionTemplate } from '../../domain/models/permission-template';
import { PermissionTemplateService } from '../../domain/services/permission-template.service';
import { orgError } from '../../domain/types';
import {
  PERMISSION_TEMPLATE_QUERY,
  PERMISSION_TEMPLATE_STORE,
  type PermissionTemplateStore,
} from '../ports';

export interface TemplateView {
  id: string;
  name: string;
  permissions: string[];
  status: 'published' | 'draft';
  version: number;
  draftVersion: number | null;
  scopeClass: PermissionTemplate['scopeClass'];
}

export function toView(t: PermissionTemplate): TemplateView {
  return {
    id: t.id,
    name: t.name,
    permissions: [...(t.published?.permissions ?? t.draft?.permissions ?? [])],
    status: t.published !== null ? 'published' : 'draft',
    version: t.published?.version ?? 0,
    draftVersion: t.draft?.version ?? null,
    scopeClass: t.scopeClass,
  };
}

export class PermissionTemplateQuery {
  constructor(private readonly store: PermissionTemplateStore) {}

  async list(): Promise<TemplateView[]> {
    const templates = await this.store.list();
    return templates.map(toView);
  }

  async diff(input: { templateId: string }): Promise<{
    added: string[];
    removed: string[];
    affectedGroups: string[];
    affectedMembers: number;
    previewVersion: number;
  }> {
    const template = await this.requireTemplate(input.templateId);
    if (template.draft === null) throw orgError.precondition('无草稿，无法差异预览');
    const bindings = await this.store.listBindings();
    const diff = PermissionTemplateService.diff(
      template.published?.permissions ?? [],
      template.draft.permissions,
    );
    const affectedGroups = bindings
      .filter((b) => b.templateId === template.id)
      .map((b) => `${b.positionGroup.owner}/${b.positionGroup.name}`);
    return {
      added: diff.added,
      removed: diff.removed,
      affectedGroups,
      affectedMembers: 0,
      previewVersion: template.draft?.version ?? 0,
    };
  }

  private async requireTemplate(templateId: string): Promise<PermissionTemplate> {
    const template = await this.store.findById(templateId);
    if (template === null) throw orgError.notVisible(`权限模板不存在（${templateId}）`);
    return template;
  }
}

export const permissionTemplateQueryProvider = {
  provide: PERMISSION_TEMPLATE_QUERY,
  useFactory: (store: PermissionTemplateStore) => new PermissionTemplateQuery(store),
  inject: [PERMISSION_TEMPLATE_STORE],
};
