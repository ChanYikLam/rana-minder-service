/**
 * 模板入库申请列表查询（管理端；FORM-010）。
 *
 * 超管按状态筛选待审/已审申请（缺省 PENDING 待审优先）；附来源表单标题供
 * 审核界面展示。读取由 controller 侧守卫限定平台超管（GOV-002）。
 */

import type { FormDefinitionRepository } from '../ports/form-definition-repository.port';
import type { FormDesignPermissionPort } from '../ports/form-design-permission.port';
import type { TemplatePublicationState } from '../../domain/models/template-publication';
import { formErrors } from '../errors';

export interface TemplatePublicationListItem {
  readonly publicationId: string;
  readonly formId: string;
  readonly formTitle: string;
  readonly sourceVersion: number;
  readonly status: TemplatePublicationState;
  readonly note: string | null;
  readonly requestedBy: string;
  readonly requestedAt: Date;
}

export interface ListTemplatePublicationsQuery {
  execute(input: { status: TemplatePublicationState | null; actor: string }): Promise<{
    items: readonly TemplatePublicationListItem[];
  }>;
}

export class DefaultListTemplatePublicationsQuery implements ListTemplatePublicationsQuery {
  constructor(
    private readonly repository: FormDefinitionRepository,
    private readonly permission: FormDesignPermissionPort,
  ) {}

  async execute(input: { status: TemplatePublicationState | null; actor: string }): Promise<{
    items: readonly TemplatePublicationListItem[];
  }> {
    if (!(await this.permission.canManagePlatform({ subjectId: input.actor }))) {
      throw formErrors.forbidden('仅平台超管可查看模板入库申请');
    }
    const publications = await this.repository.listTemplatePublications(input.status);
    const items: TemplatePublicationListItem[] = [];
    for (const publication of publications) {
      const root = await this.repository.loadRoot(publication.formId);
      items.push({
        publicationId: publication.id,
        formId: publication.formId,
        formTitle: root?.title ?? '（来源表单不可见）',
        sourceVersion: publication.sourceVersion,
        status: publication.status,
        note: publication.note,
        requestedBy: publication.requestedBy,
        requestedAt: publication.requestedAt,
      });
    }
    return { items };
  }
}
