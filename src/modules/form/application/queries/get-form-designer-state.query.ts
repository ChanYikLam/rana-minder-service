/**
 * 设计器编辑态查询（GET 端点 mock：最新草稿，无则回退已发布）。
 *
 * 返回设计器画布所需单版本：当前草稿（DRAFT/PREVIEW_TESTING）优先，
 * 无草稿回退当前发布版本（只读回显，不含可发布标志语义）。
 */

import type { FormDefinitionRepository } from '../ports/form-definition-repository.port';
import type { FormDesignPermissionPort } from '../ports/form-design-permission.port';
import type { FormFieldSet } from '../../domain/models/form-field';
import { FormVersionState } from '../../domain/state-machines/form-version.state-machine';
import { formErrors } from '../errors';

export interface GetFormDesignerStateResult {
  readonly formId: string;
  readonly title: string;
  readonly status: 'draft' | 'preview_testing' | 'published' | 'deprecated';
  readonly version: number | null;
  readonly fields: FormFieldSet;
}

export interface GetFormDesignerStateQuery {
  execute(input: { formId: string; actor: string }): Promise<GetFormDesignerStateResult>;
}

export class DefaultGetFormDesignerStateQuery implements GetFormDesignerStateQuery {
  constructor(
    private readonly repository: FormDefinitionRepository,
    private readonly permission: FormDesignPermissionPort,
  ) {}

  async execute(input: { formId: string; actor: string }): Promise<GetFormDesignerStateResult> {
    const root = await this.repository.loadRoot(input.formId);
    if (root === null) {
      throw formErrors.notFound('表单');
    }
    if (!(await this.permission.canDesign({ subjectId: input.actor }, root.scope))) {
      throw formErrors.forbidden('当前角色无权查看该表单设计');
    }
    const latest = await this.repository.loadLatestVersion(input.formId);
    if (
      latest !== null &&
      (latest.status === FormVersionState.DRAFT ||
        latest.status === FormVersionState.PREVIEW_TESTING)
    ) {
      return {
        formId: root.id,
        title: root.title,
        status: latest.status.toLowerCase() as 'draft' | 'preview_testing',
        version: latest.versionNumber,
        fields: latest.fields,
      };
    }
    if (root.currentPublishedVersion !== null) {
      const published = await this.repository.loadVersion(
        input.formId,
        root.currentPublishedVersion,
      );
      if (published !== null) {
        return {
          formId: root.id,
          title: root.title,
          status: published.status.toLowerCase() as 'published' | 'deprecated',
          version: published.versionNumber,
          fields: published.fields,
        };
      }
    }
    if (latest !== null) {
      return {
        formId: root.id,
        title: root.title,
        status: latest.status.toLowerCase() as GetFormDesignerStateResult['status'],
        version: latest.versionNumber,
        fields: latest.fields,
      };
    }
    return { formId: root.id, title: root.title, status: 'draft', version: null, fields: [] };
  }
}
