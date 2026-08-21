/**
 * 创建表单草稿用例（SRS-SM-FORM-001 t1；FORM-001/002）。
 *
 * 创建表单根（FORM）并原子落位草稿版本 1（固定业务骨架已选）；创建幂等
 * （IFC-GEN-006、SRS-SM-FORM-001 t1）。设计/发布权限：超管管平台，
 * 社团负责人/人事管本社团（FORM-002、GOV-003）；普通成员与面试官只能填写
 * 不能设计（4.1.2）。
 */

import { randomUUID } from 'node:crypto';
import { FormDefinition } from '../../domain/models/form-definition';
import { FormVersion } from '../../domain/models/form-version';
import { formScopeOf, scopeKeyOf, type FormScope } from '../../domain/models/form-scope';
import { isFormBusinessFamily } from '../../domain/models/form-field';
import type { FormDefinitionRepository } from '../ports/form-definition-repository.port';
import type { FormDesignPermissionPort } from '../ports/form-design-permission.port';
import type { FormAuditPort } from '../ports/form-audit.port';
import type { FormIdempotencyStore } from '../ports/form-idempotency-store.port';
import { formErrors } from '../errors';
import { CommandIdempotencyGate } from '../services/command-idempotency';
import { semanticHashOf } from '../services/idempotency-key';

const MAX_TITLE_LENGTH = 120;

export interface CreateFormDraftInput {
  readonly scope: FormScope;
  readonly title: string;
  readonly description: string | null;
  readonly businessFamily: string | null;
  readonly actor: string;
  readonly now: Date;
  readonly traceId: string | null;
  readonly idempotencyKey?: string;
}

export interface CreateFormDraftResult {
  readonly formId: string;
  readonly draftVersion: number;
  readonly title: string;
}

export interface CreateFormDraftUseCase {
  execute(input: CreateFormDraftInput): Promise<CreateFormDraftResult>;
}

export class DefaultCreateFormDraftUseCase implements CreateFormDraftUseCase {
  constructor(
    private readonly repository: FormDefinitionRepository,
    private readonly permission: FormDesignPermissionPort,
    private readonly audit: FormAuditPort,
    private readonly idempotency: FormIdempotencyStore,
  ) {}

  async execute(input: CreateFormDraftInput): Promise<CreateFormDraftResult> {
    const scope = formScopeOf(input.scope.kind, input.scope.ownerId);
    const title = input.title.trim();
    if (title.length === 0 || title.length > MAX_TITLE_LENGTH) {
      throw formErrors.validationFailed('表单标题缺失或超长', {
        title: [`标题必须是非空字符串且不超过 ${MAX_TITLE_LENGTH} 字符`],
      });
    }
    if (input.businessFamily !== null && !isFormBusinessFamily(input.businessFamily)) {
      throw formErrors.validationFailed('业务表单族不在目录内', {
        businessFamily: ['业务表单族不在目录内'],
      });
    }

    if (!(await this.permission.canDesign({ subjectId: input.actor }, scope))) {
      throw formErrors.forbidden('当前角色无权设计该作用域表单');
    }

    const gate = new CommandIdempotencyGate(
      this.idempotency,
      `create-draft:${scopeKeyOf(scope)}`,
      input.idempotencyKey,
      semanticHashOf({
        scope,
        title,
        description: input.description,
        businessFamily: input.businessFamily,
      }),
    );
    const begin = await gate.begin();
    if (!begin.proceed) {
      const previous = begin.replay as CreateFormDraftResult;
      return {
        formId: previous.formId,
        draftVersion: previous.draftVersion,
        title: previous.title,
      };
    }

    const root = FormDefinition.create({
      id: randomUUID(),
      scope,
      kind: 'FORM',
      title,
      description: input.description,
      businessFamily: input.businessFamily,
      createdBy: input.actor,
      now: input.now,
    });
    const draft = FormVersion.createDraft({
      id: randomUUID(),
      formId: root.id,
      versionNumber: 1,
      fields: [],
      sourceFormId: null,
      sourceVersion: null,
      createdBy: input.actor,
      now: input.now,
    });
    root.pointDraft(1, input.now);

    await this.repository.insertVersion(draft.toSnapshot());
    await this.repository.saveRoot(root.toSnapshot(), 0);

    await this.audit.record({
      type: 'FORM_DRAFT_CREATED',
      subjectId: root.id,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId,
      summary: {
        action: 'CREATED',
        formId: root.id,
        scope: scope.kind,
        ownerId: scope.ownerId,
        title,
        versionNumber: 1,
      },
    });

    const result: CreateFormDraftResult = { formId: root.id, draftVersion: 1, title };
    await gate.finish(result);
    return result;
  }
}
