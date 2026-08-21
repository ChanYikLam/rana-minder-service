/**
 * 权限模板命令用例（§15.3 POST /api/admin/config/permission-templates*）。
 *
 * 写操作（新建/保存草稿/发布）从 PermissionTemplateQuery 中拆出，遵循只读/CQRS
 * 约定：查询只读，命令承载变更；规则校验委托 PermissionTemplateService。
 *
 * - 发布按"草稿 → 已发布不可变版本"走（DATA-CFG-001），失败保留旧发布版本。
 * - 仅平台超管可配置（ORG-019/035），接口层门禁 + use case 复验。
 */

import { randomUUID } from 'node:crypto';

import type { PermissionTemplate } from '../../domain/models/permission-template';
import { PermissionTemplateService } from '../../domain/services/permission-template.service';
import { IdPrefix, orgError } from '../../domain/types';
import { type TemplateView, toView } from '../queries/permission-template.query';
import {
  PERMISSION_TEMPLATE_COMMAND,
  PERMISSION_TEMPLATE_STORE,
  type PermissionTemplateStore,
} from '../ports';

export class PermissionTemplateCommand {
  constructor(private readonly store: PermissionTemplateStore) {}

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
      newId(IdPrefix.PERMISSION_TEMPLATE),
    );
    await this.store.save(draft);
    return toView(draft);
  }

  async saveDraft(input: {
    templateId: string;
    name: string;
    permissions: string[];
  }): Promise<TemplateView> {
    const existing = await requireTemplate(this.store, input.templateId);
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

  async publish(input: {
    templateId: string;
    reauthProof: string;
    previewVersion: number;
    reason: string;
  }): Promise<TemplateView> {
    if (input.reauthProof === undefined) {
      throw orgError.reauth('发布权限模板为高风控操作，需重新认证（IFC-ERR-002）');
    }
    const template = await requireTemplate(this.store, input.templateId);
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
}

async function requireTemplate(
  store: PermissionTemplateStore,
  templateId: string,
): Promise<PermissionTemplate> {
  const template = await store.findById(templateId);
  if (template === null) throw orgError.notVisible(`权限模板不存在（${templateId}）`);
  return template;
}

function newId(prefix: IdPrefix): string {
  return `${prefix}-${randomUUID()}`;
}

export const permissionTemplateCommandProvider = {
  provide: PERMISSION_TEMPLATE_COMMAND,
  useFactory: (store: PermissionTemplateStore) => new PermissionTemplateCommand(store),
  inject: [PERMISSION_TEMPLATE_STORE],
};
