/**
 * 查询：权限模板（§15.3 GET/POST /api/admin/config/permission-templates*）。
 *
 * 只读查询 + 模板草稿/发布操作委托 PermissionTemplateService 规则校验。
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

function toView(t: PermissionTemplate): TemplateView {
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

  async create(input: { name: string; permissions: string[] }): Promise<TemplateView> {
    if (input.name.trim() === '' || input.permissions.length === 0) {
      throw orgError.validation('名称与权限不能为空');
    }
    const at = new Date().toISOString();
    const draft = PermissionTemplateService.createTemplateDraft(
      null,
      input.name,
      PermissionTemplateService.validateDraftPermissions('club', input.permissions),
      at,
    );
    draft.id = `${draft.id}-${Date.now().toString(36)}`;
    await this.store.save(draft);
    return toView(draft);
  }

  async saveDraft(input: {
    templateId: string;
    name: string;
    permissions: string[];
  }): Promise<TemplateView> {
    const existing = await this.requireTemplate(input.templateId);
    const at = new Date().toISOString();
    const updated = PermissionTemplateService.createTemplateDraft(
      existing,
      input.name,
      PermissionTemplateService.validateDraftPermissions(existing.scopeClass, input.permissions),
      at,
    );
    await this.store.save(updated);
    return toView(updated);
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
      previewVersion: (template.draft?.version ?? 0) + 1,
    };
  }

  async publish(input: {
    templateId: string;
    reauthProof: string;
    previewVersion: number;
    reason: string;
  }): Promise<TemplateView> {
    if (input.reauthProof === undefined) {
      throw orgError.reauth('发布权限模板为高风控操作，需重新认证（IFC-ERR-002）');
    }
    const template = await this.requireTemplate(input.templateId);
    if (template.draft === null) throw orgError.precondition('仅草稿可发布');
    if (input.reason.trim() === '') throw orgError.validation('必须填写发布原因');
    // 预检版本号竞争（IFC-ERR-008）
    if (input.previewVersion !== (template.draft.version ?? 0) + 1) {
      throw orgError.versionConflict('previewVersion 与当前草稿版本不符（IFC-ERR-008）');
    }
    const published: PermissionTemplate = {
      ...template,
      published: {
        version: template.draft.version,
        name: template.draft.name,
        permissions: template.draft.permissions,
      },
      draft: null,
    };
    await this.store.save(published);
    return toView(published);
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
