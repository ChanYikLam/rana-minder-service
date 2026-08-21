/**
 * 模板入库审核用例（FORM-010；GOV-002 超管；DATA-FRM-002）。
 *
 * 超管审核 PENDING 申请：批准 → 物化平台模板根＋已发布 v1（对象类型选项清空、
 * 不含提交数据），模板独立演进；驳回 → 带理由拒绝，申请终态。审核单胜者
 * （PENDING → APPROVED/REJECTED 只一次成功，IFC-ERR-010）。
 */

import { randomUUID } from 'node:crypto';
import { FormDefinition } from '../../domain/models/form-definition';
import { FormVersion } from '../../domain/models/form-version';
import { PLATFORM_SCOPE } from '../../domain/models/form-scope';
import type { FormFieldSet } from '../../domain/models/form-field';
import { copyFieldSetForTemplate } from '../../domain/services/form-template-copy.policy';
import { TemplatePublication } from '../../domain/models/template-publication';
import type { FormDefinitionRepository } from '../ports/form-definition-repository.port';
import type { FormDesignPermissionPort } from '../ports/form-design-permission.port';
import type { FormAuditPort } from '../ports/form-audit.port';
import { formErrors } from '../errors';

export interface ReviewTemplatePublicationInput {
  readonly publicationId: string;
  readonly decision: 'APPROVE' | 'REJECT';
  readonly reason: string | null;
  readonly actor: string;
  readonly now: Date;
  readonly traceId: string | null;
}

export interface ReviewTemplatePublicationResult {
  readonly publicationId: string;
  readonly status: 'APPROVED' | 'REJECTED';
  /** 批准时物化的平台模板 id */
  readonly templateFormId: string | null;
}

export interface ReviewTemplatePublicationUseCase {
  execute(input: ReviewTemplatePublicationInput): Promise<ReviewTemplatePublicationResult>;
}

export class DefaultReviewTemplatePublicationUseCase implements ReviewTemplatePublicationUseCase {
  constructor(
    private readonly repository: FormDefinitionRepository,
    private readonly permission: FormDesignPermissionPort,
    private readonly audit: FormAuditPort,
  ) {}

  async execute(input: ReviewTemplatePublicationInput): Promise<ReviewTemplatePublicationResult> {
    if (input.decision !== 'APPROVE' && input.decision !== 'REJECT') {
      throw formErrors.validationFailed('审核结论必须是 APPROVE 或 REJECT', {
        decision: ['必须是 APPROVE 或 REJECT'],
      });
    }
    if (
      input.decision === 'REJECT' &&
      (input.reason === null || input.reason.trim().length === 0)
    ) {
      throw formErrors.validationFailed('驳回必须提供理由', { reason: ['驳回必须提供理由'] });
    }
    if (!(await this.permission.canManagePlatform({ subjectId: input.actor }))) {
      throw formErrors.forbidden('仅平台超管可审核模板入库申请');
    }

    const publicationSnapshot = await this.repository.loadTemplatePublication(input.publicationId);
    if (publicationSnapshot === null) {
      throw formErrors.notFound('模板入库申请');
    }
    const publication = TemplatePublication.fromSnapshot(publicationSnapshot);

    if (input.decision === 'REJECT') {
      if (!publication.reject(input.reason as string, input.actor, input.now)) {
        throw formErrors.preconditionFailed('该申请已审核，不可重复审核');
      }
      await this.repository.saveTemplatePublicationWithStatusGuard(publication.toSnapshot());
      await this.audit.record({
        type: 'FORM_TEMPLATE_PUBLICATION_DECIDED',
        subjectId: input.publicationId,
        occurredAt: input.now,
        actor: input.actor,
        traceId: input.traceId,
        summary: {
          action: 'REJECTED',
          publicationId: input.publicationId,
          formId: publication.formId,
          reason: input.reason,
        },
      });
      return { publicationId: input.publicationId, status: 'REJECTED', templateFormId: null };
    }

    const sourceRoot = await this.repository.loadRoot(publication.formId);
    if (sourceRoot === null || sourceRoot.kind !== 'FORM') {
      throw formErrors.preconditionFailed('来源表单已不存在，无法批准');
    }
    const sourceVersion = await this.repository.loadVersion(
      publication.formId,
      publication.sourceVersion,
    );
    if (sourceVersion === null) {
      throw formErrors.preconditionFailed('来源表单版本已不存在，无法批准');
    }

    const templateRoot = FormDefinition.create({
      id: randomUUID(),
      scope: PLATFORM_SCOPE,
      kind: 'TEMPLATE',
      title: sourceRoot.title,
      description: sourceRoot.description,
      businessFamily: sourceRoot.businessFamily,
      createdBy: input.actor,
      now: input.now,
    });
    const templateVersion = FormVersion.createPublished({
      id: randomUUID(),
      formId: templateRoot.id,
      versionNumber: 1,
      fields: copyFieldSetForTemplate(sourceVersion.fields as unknown as FormFieldSet),
      sourceFormId: publication.formId,
      sourceVersion: publication.sourceVersion,
      publishedBy: input.actor,
      now: input.now,
    });
    templateRoot.pointPublished(1, input.now);

    await this.repository.insertVersion(templateVersion.toSnapshot());
    await this.repository.saveRoot(templateRoot.toSnapshot(), 0);

    if (!publication.approve(templateRoot.id, input.actor, input.now)) {
      throw formErrors.preconditionFailed('该申请已审核，不可重复审核');
    }
    await this.repository.saveTemplatePublicationWithStatusGuard(publication.toSnapshot());

    await this.audit.record({
      type: 'FORM_TEMPLATE_PUBLICATION_DECIDED',
      subjectId: input.publicationId,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        action: 'APPROVED',
        publicationId: input.publicationId,
        formId: publication.formId,
        templateFormId: templateRoot.id,
      },
    });

    return {
      publicationId: input.publicationId,
      status: 'APPROVED',
      templateFormId: templateRoot.id,
    };
  }
}
