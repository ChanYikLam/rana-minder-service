/**
 * 申请模板入库用例（FORM-010；DATA-FRM-002）。
 *
 * 已发布表单 → 模板库入库申请（PENDING）：复制发布版本的结构、字段与校验
 * （对象类型选项清空），提交数据/附件/内部信息不入库；待超管审核
 * （ReviewTemplatePublicationUseCase）。申请幂等（IFC-GEN-006）。
 */

import { randomUUID } from 'node:crypto';
import { TemplatePublication } from '../../domain/models/template-publication';
import { scopeKeyOf } from '../../domain/models/form-scope';
import type { FormDefinitionRepository } from '../ports/form-definition-repository.port';
import type { FormDesignPermissionPort } from '../ports/form-design-permission.port';
import type { FormAuditPort } from '../ports/form-audit.port';
import type { FormIdempotencyStore } from '../ports/form-idempotency-store.port';
import { formErrors } from '../errors';
import { CommandIdempotencyGate } from '../services/command-idempotency';
import { semanticHashOf } from '../services/idempotency-key';

export interface RequestTemplatePublicationInput {
  readonly formId: string;
  readonly note: string | null;
  readonly actor: string;
  readonly now: Date;
  readonly traceId: string | null;
  readonly idempotencyKey?: string;
}

export interface RequestTemplatePublicationResult {
  readonly publicationId: string;
  readonly status: 'PENDING';
}

export interface RequestTemplatePublicationUseCase {
  execute(input: RequestTemplatePublicationInput): Promise<RequestTemplatePublicationResult>;
}

export class DefaultRequestTemplatePublicationUseCase implements RequestTemplatePublicationUseCase {
  constructor(
    private readonly repository: FormDefinitionRepository,
    private readonly permission: FormDesignPermissionPort,
    private readonly audit: FormAuditPort,
    private readonly idempotency: FormIdempotencyStore,
  ) {}

  async execute(input: RequestTemplatePublicationInput): Promise<RequestTemplatePublicationResult> {
    const root = await this.repository.loadRoot(input.formId);
    if (root === null || root.kind !== 'FORM') {
      throw formErrors.notFound('表单');
    }
    if (root.scope.kind !== 'club') {
      throw formErrors.preconditionFailed('仅社团表单可申请入库平台模板库');
    }
    if (root.currentPublishedVersion === null) {
      throw formErrors.preconditionFailed('仅已发布表单可申请入库模板库');
    }
    if (!(await this.permission.canDesign({ subjectId: input.actor }, root.scope))) {
      throw formErrors.forbidden('当前角色无权申请该表单入库');
    }

    const gate = new CommandIdempotencyGate(
      this.idempotency,
      `request-template-publication:${scopeKeyOf(root.scope)}`,
      input.idempotencyKey,
      semanticHashOf({
        formId: input.formId,
        sourceVersion: root.currentPublishedVersion,
        note: input.note,
      }),
    );
    const begin = await gate.begin();
    if (!begin.proceed) {
      const previous = begin.replay as RequestTemplatePublicationResult;
      return { ...previous };
    }

    const publication = TemplatePublication.create({
      id: randomUUID(),
      formId: input.formId,
      sourceVersion: root.currentPublishedVersion,
      note: input.note,
      requestedBy: input.actor,
      now: input.now,
    });
    await this.repository.saveTemplatePublication(publication.toSnapshot());

    await this.audit.record({
      type: 'FORM_TEMPLATE_PUBLICATION_REQUESTED',
      subjectId: publication.id,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        action: 'REQUESTED',
        publicationId: publication.id,
        formId: input.formId,
        sourceVersion: root.currentPublishedVersion,
      },
    });

    const result: RequestTemplatePublicationResult = {
      publicationId: publication.id,
      status: 'PENDING',
    };
    await gate.finish(result);
    return result;
  }
}
