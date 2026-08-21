/**
 * 复制自有表单用例（FORM-010；SRS-SM-FORM-001 t1 独立草稿）。
 *
 * 复制本社团/部门已有表单为同作用域独立草稿：只复制结构、字段与校验，
 * 不含提交数据；副本独立演进。来源取当前发布版本（稳定），无则取最新版本。
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

export interface CloneFormInput {
  readonly sourceFormId: string;
  /** 副本作用域（与来源同作用域，跨作用域复制一律拒绝） */
  readonly targetScope: FormScope;
  readonly title: string | null;
  readonly actor: string;
  readonly now: Date;
  readonly traceId: string | null;
  readonly idempotencyKey?: string;
}

export interface CloneFormResult {
  readonly formId: string;
  readonly title: string;
  readonly draftVersion: number;
  readonly sourceFormId: string;
  readonly sourceVersion: number;
}

export interface CloneFormUseCase {
  execute(input: CloneFormInput): Promise<CloneFormResult>;
}

export class DefaultCloneFormUseCase implements CloneFormUseCase {
  constructor(
    private readonly repository: FormDefinitionRepository,
    private readonly permission: FormDesignPermissionPort,
    private readonly audit: FormAuditPort,
    private readonly idempotency: FormIdempotencyStore,
  ) {}

  async execute(input: CloneFormInput): Promise<CloneFormResult> {
    const sourceRoot = await this.repository.loadRoot(input.sourceFormId);
    if (sourceRoot === null || sourceRoot.kind !== 'FORM') {
      throw formErrors.notFound('表单');
    }
    if (
      sourceRoot.scope.kind !== input.targetScope.kind ||
      sourceRoot.scope.ownerId !== input.targetScope.ownerId
    ) {
      throw formErrors.forbidden('仅可在来源表单所属作用域内复制');
    }
    if (!(await this.permission.canDesign({ subjectId: input.actor }, sourceRoot.scope))) {
      throw formErrors.forbidden('当前角色无权复制该表单');
    }

    let sourceVersionNumber = sourceRoot.currentPublishedVersion;
    let source: Awaited<ReturnType<FormDefinitionRepository['loadLatestVersion']>> = null;
    if (sourceVersionNumber !== null) {
      source = await this.repository.loadVersion(input.sourceFormId, sourceVersionNumber);
    }
    if (source === null) {
      source = await this.repository.loadLatestVersion(input.sourceFormId);
      if (source !== null) {
        sourceVersionNumber = source.versionNumber;
      }
    }
    if (source === null || sourceVersionNumber === null) {
      throw formErrors.preconditionFailed('来源表单尚无可用版本');
    }

    const gate = new CommandIdempotencyGate(
      this.idempotency,
      `clone-form:${scopeKeyOf(sourceRoot.scope)}`,
      input.idempotencyKey,
      semanticHashOf({ sourceFormId: input.sourceFormId, sourceVersionNumber, title: input.title }),
    );
    const begin = await gate.begin();
    if (!begin.proceed) {
      const previous = begin.replay as CloneFormResult;
      return { ...previous };
    }

    const title = (input.title ?? `${sourceRoot.title}（副本）`).trim();
    const root = FormDefinition.create({
      id: randomUUID(),
      scope: sourceRoot.scope,
      kind: 'FORM',
      title,
      description: sourceRoot.description,
      businessFamily: sourceRoot.businessFamily,
      createdBy: input.actor,
      now: input.now,
    });
    const draft = FormVersion.createDraft({
      id: randomUUID(),
      formId: root.id,
      versionNumber: 1,
      fields: copyFieldSetForTemplate(source.fields as unknown as FormFieldSet),
      sourceFormId: input.sourceFormId,
      sourceVersion: source.versionNumber,
      createdBy: input.actor,
      now: input.now,
    });
    root.pointDraft(1, input.now);

    await this.repository.insertVersion(draft.toSnapshot());
    await this.repository.saveRoot(root.toSnapshot(), 0);

    await this.audit.record({
      type: 'FORM_CLONED',
      subjectId: root.id,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        action: 'CLONED',
        formId: root.id,
        sourceFormId: input.sourceFormId,
        sourceVersion: source.versionNumber,
        title,
      },
    });

    const result: CloneFormResult = {
      formId: root.id,
      title,
      draftVersion: 1,
      sourceFormId: input.sourceFormId,
      sourceVersion: source.versionNumber,
    };
    await gate.finish(result);
    return result;
  }
}
