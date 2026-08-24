/**
 * 表单列表查询（FORM-001；GET 端点）。
 *
 * 返回指定作用域表单列表：根信息＋最新版本信息（版本号、状态、可发布标志）。
 * 状态推导：最新版本为草稿/预览中 → draft；有当前发布版本 → published；
 * 其余 → deprecated。查询不暴露字段明细（设计器编辑态走 DesignerState 查询）。
 */

import type { FormDefinitionRepository } from '../ports/form-definition-repository.port';
import type { FormDesignPermissionPort } from '../ports/form-design-permission.port';
import type { FormScope } from '../../domain/models/form-scope';
import { FormVersionState } from '../../domain/state-machines/form-version.state-machine';
import { formErrors } from '../errors';

export type FormListStatus = 'draft' | 'published' | 'deprecated';

export interface FormListItem {
  readonly formId: string;
  readonly title: string;
  readonly description: string | null;
  readonly businessFamily: string | null;
  readonly version: number;
  readonly status: FormListStatus;
  readonly publishable: boolean;
  readonly updatedAt: Date;
}

export interface ListFormsQuery {
  execute(input: { scope: FormScope; actor: string }): Promise<{ items: readonly FormListItem[] }>;
}

export class DefaultListFormsQuery implements ListFormsQuery {
  constructor(
    private readonly repository: FormDefinitionRepository,
    private readonly permission: FormDesignPermissionPort,
  ) {}

  async execute(input: {
    scope: FormScope;
    actor: string;
  }): Promise<{ items: readonly FormListItem[] }> {
    if (!(await this.permission.canDesign({ subjectId: input.actor }, input.scope))) {
      throw formErrors.forbidden('当前角色无权查看该作用域表单');
    }
    const roots = await this.repository.listByScope(input.scope);
    const items: FormListItem[] = [];
    for (const root of roots) {
      const latest = await this.repository.loadLatestVersion(root.id);
      let version = 0;
      let status: FormListStatus = 'draft';
      let publishable = false;
      if (latest !== null) {
        version = latest.versionNumber;
        if (
          latest.status === FormVersionState.DRAFT ||
          latest.status === FormVersionState.PREVIEW_TESTING
        ) {
          status = 'draft';
          publishable = latest.publishable;
        } else if (root.currentPublishedVersion !== null) {
          status = 'published';
        } else {
          status = 'deprecated';
        }
      }
      items.push({
        formId: root.id,
        title: root.title,
        description: root.description,
        businessFamily: root.businessFamily,
        version,
        status,
        publishable,
        updatedAt: root.updatedAt,
      });
    }
    items.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return { items };
  }
}
