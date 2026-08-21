/**
 * 从平台模板创建表单用例（FORM-011；SRS-SM-FORM-001 t1 独立草稿）。
 *
 * 复制平台模板（超管审核通过的物化模板）为指定作用域独立草稿：只复制结构、
 * 字段与校验，不含提交数据；对象类型选项清空须重新配置。模板副本独立演进。
 * 创建幂等（IFC-GEN-006）。
 */

import { randomUUID } from 'node:crypto';
import { FormDefinition } from '../../domain/models/form-definition';
import { FormVersion } from '../../domain/models/form-version';
import { scopeKeyOf, type FormScope } from '../../domain/models/form-scope';
import type { FormFieldSet } from '../../domain/models/form-field';
import { copyFieldSetForTemplate } from '../../domain/services/form-template-copy.policy';
import type { FormDefinitionRepository } from '../ports/form-definition-repository.port';
import type { FormDesignPermissionPort } from '../ports/form-design-permission.port';
import type { FormAuditPort } from '../ports/form-audit.port';
import type { FormIdempotencyStore } from '../ports/form-idempotency-store.port';
import { formErrors } from '../errors';
import { CommandIdempotencyGate } from '../services/command-idempotency';
import { semanticHashOf } from '../services/idempotency-key';

export interface CopyTemplateInput {
  readonly templateId: string;
  readonly targetScope: FormScope;
  readonly title: string | null;
  readonly actor: string;
  readonly now: Date;
  readonly traceId: string | null;
  readonly idempotencyKey?: string;
}

export interface CopyTemplateResult {
  readonly formId: string;
  readonly title: string;
  readonly draftVersion: number;
  readonly templateId: string;
  readonly templateVersion: number;
}

export interface CopyTemplateUseCase {
  execute(input: CopyTemplateInput): Promise<CopyTemplateResult>;
}

export class DefaultCopyTemplateUseCase implements CopyTemplateUseCase {
  constructor(
    private readonly repository: FormDefinitionRepository,
    private readonly permission: FormDesignPermissionPort,
    private readonly audit: FormAuditPort,
    private readonly idempotency: FormIdempotencyStore,
  ) {}

  async execute(input: CopyTemplateInput): Promise<CopyTemplateResult> {
    const template = await this.repository.loadRoot(input.templateId);
    if (template === null || template.kind !== 'TEMPLATE') {
      throw formErrors.notFound('模板');
    }
    if (!(await this.permission.canDesign({ subjectId: input.actor }, input.targetScope))) {
      throw formErrors.forbidden('当前角色无权在该作用域创建表单');
    }

    const templateVersionNumber = template.currentPublishedVersion;
    if (templateVersionNumber === null) {
      throw formErrors.preconditionFailed('模板尚无已发布可用版本');
    }
    const templateVersion = await this.repository.loadVersion(
      input.templateId,
      templateVersionNumber,
    );
    if (templateVersion === null) {
      throw formErrors.preconditionFailed('模板尚无已发布可用版本');
    }

    const gate = new CommandIdempotencyGate(
      this.idempotency,
      `copy-template:${scopeKeyOf(input.targetScope)}`,
      input.idempotencyKey,
      semanticHashOf({ templateId: input.templateId, templateVersionNumber, title: input.title }),
    );
    const begin = await gate.begin();
    if (!begin.proceed) {
      const previous = begin.replay as CopyTemplateResult;
      return { ...previous };
    }

    const title = (input.title ?? `${template.title}（模板副本）`).trim();
    const root = FormDefinition.create({
      id: randomUUID(),
      scope: input.targetScope,
      kind: 'FORM',
      title,
      description: template.description,
      businessFamily: template.businessFamily,
      createdBy: input.actor,
      now: input.now,
    });
    const draft = FormVersion.createDraft({
      id: randomUUID(),
      formId: root.id,
      versionNumber: 1,
      fields: copyFieldSetForTemplate(templateVersion.fields as unknown as FormFieldSet),
      sourceFormId: input.templateId,
      sourceVersion: templateVersionNumber,
      createdBy: input.actor,
      now: input.now,
    });
    root.pointDraft(1, input.now);

    await this.repository.insertVersion(draft.toSnapshot());
    await this.repository.saveRoot(root.toSnapshot(), 0);

    await this.audit.record({
      type: 'FORM_TEMPLATE_COPIED',
      subjectId: root.id,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        action: 'TEMPLATE_COPIED',
        formId: root.id,
        templateId: input.templateId,
        templateVersion: templateVersionNumber,
        title,
      },
    });

    const result: CopyTemplateResult = {
      formId: root.id,
      title,
      draftVersion: 1,
      templateId: input.templateId,
      templateVersion: templateVersionNumber,
    };
    await gate.finish(result);
    return result;
  }
}
