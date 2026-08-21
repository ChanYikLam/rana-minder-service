/**
 * 表单定义查询（FORM-001；GET 端点）。
 *
 * 返回根信息与全部版本（含字段明细）；版本按号升序。设计器需要当前编辑态
 * 走 GetFormDesignerStateQuery（单版本），列表类消费方用本查询。
 */

import type { FormDefinitionRepository } from '../ports/form-definition-repository.port';
import type { FormDesignPermissionPort } from '../ports/form-design-permission.port';
import type { FormScope } from '../../domain/models/form-scope';
import type { FormFieldSet } from '../../domain/models/form-field';
import { formErrors } from '../errors';

export interface FormVersionDetail {
  readonly versionNumber: number;
  readonly status: 'draft' | 'preview_testing' | 'published' | 'deprecated';
  readonly publishable: boolean;
  readonly fields: FormFieldSet;
  readonly sourceVersion: number | null;
  readonly publishedAt: Date | null;
  readonly deprecatedAt: Date | null;
  readonly createdAt: Date;
}

export interface GetFormDefinitionResult {
  readonly formId: string;
  readonly scope: FormScope;
  readonly kind: 'FORM' | 'TEMPLATE';
  readonly title: string;
  readonly description: string | null;
  readonly businessFamily: string | null;
  readonly currentDraftVersion: number | null;
  readonly currentPublishedVersion: number | null;
  readonly versions: readonly FormVersionDetail[];
  readonly updatedAt: Date;
}

export interface GetFormDefinitionQuery {
  execute(input: { formId: string; actor: string }): Promise<GetFormDefinitionResult>;
}

export class DefaultGetFormDefinitionQuery implements GetFormDefinitionQuery {
  constructor(
    private readonly repository: FormDefinitionRepository,
    private readonly permission: FormDesignPermissionPort,
  ) {}

  async execute(input: { formId: string; actor: string }): Promise<GetFormDefinitionResult> {
    const root = await this.repository.loadRoot(input.formId);
    if (root === null) {
      throw formErrors.notFound('表单');
    }
    if (!(await this.permission.canDesign({ subjectId: input.actor }, root.scope))) {
      throw formErrors.forbidden('当前角色无权查看该表单定义');
    }
    const versions = await this.repository.loadVersions(input.formId);
    return {
      formId: root.id,
      scope: root.scope,
      kind: root.kind,
      title: root.title,
      description: root.description,
      businessFamily: root.businessFamily,
      currentDraftVersion: root.currentDraftVersion,
      currentPublishedVersion: root.currentPublishedVersion,
      versions: versions.map((v) => ({
        versionNumber: v.versionNumber,
        status: v.status.toLowerCase() as FormVersionDetail['status'],
        publishable: v.publishable,
        fields: v.fields,
        sourceVersion: v.sourceVersion,
        publishedAt: v.publishedAt,
        deprecatedAt: v.deprecatedAt,
        createdAt: v.createdAt,
      })),
      updatedAt: root.updatedAt,
    };
  }
}
