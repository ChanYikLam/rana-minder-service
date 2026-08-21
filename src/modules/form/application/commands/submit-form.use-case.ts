/**
 * 提交表单用例（FORM-002、DATA-FRM-001/002、IFC-DATA-005）。
 *
 * 提交前置：填写权限（fail-closed 桩）、目标版本须为已发布（PREVIEW 之前不可填）、
 * 答案按不可变版本重验；同一提交者对一个版本仅一份提交（重复提交须走修订）。
 * 提交幂等（IFC-GEN-006）。
 */

import { randomUUID } from 'node:crypto';
import { FormSubmission, type FormAnswerValue } from '../../domain/models/form-submission';
import { DefaultFormSubmissionStateMachine } from '../../domain/state-machines/form-submission.state-machine';
import { validateFormAnswer } from '../../domain/services/form-answer.validator';
import { FormVersionState } from '../../domain/state-machines/form-version.state-machine';
import { scopeKeyOf, type FormScope } from '../../domain/models/form-scope';
import type { FormDefinitionRepository } from '../ports/form-definition-repository.port';
import type { FormSubmissionRepository } from '../ports/form-submission-repository.port';
import type { FormFillPermissionPort } from '../ports/form-fill-permission.port';
import type { FormAuditPort } from '../ports/form-audit.port';
import type { FormIdempotencyStore } from '../ports/form-idempotency-store.port';
import { formErrors } from '../errors';
import { CommandIdempotencyGate } from '../services/command-idempotency';
import { semanticHashOf } from '../services/idempotency-key';

export interface SubmitFormInput {
  readonly id?: string;
  readonly formId: string;
  readonly versionNumber: number;
  readonly scope: FormScope;
  readonly submittedBy: string;
  readonly values: Record<string, unknown>;
  readonly actor: string;
  readonly now: Date;
  readonly traceId?: string | null;
  readonly idempotencyKey?: string;
}

export interface SubmitFormResult {
  readonly submissionId: string;
}

export interface SubmitFormUseCase {
  execute(input: SubmitFormInput): Promise<SubmitFormResult>;
}

export class DefaultSubmitFormUseCase implements SubmitFormUseCase {
  constructor(
    private readonly submissions: FormSubmissionRepository,
    private readonly definitions: FormDefinitionRepository,
    private readonly fillPermission: FormFillPermissionPort,
    private readonly audit: FormAuditPort,
    private readonly idempotency: FormIdempotencyStore,
  ) {}

  async execute(input: SubmitFormInput): Promise<SubmitFormResult> {
    const fill = await this.fillPermission.canFill({
      formId: input.formId,
      versionNumber: input.versionNumber,
      scope: input.scope,
      subjectId: input.actor,
    });
    if (!fill.allowed) {
      throw formErrors.forbidden(fill.reason ?? '无权填写该表单');
    }

    const version = await this.definitions.loadVersion(input.formId, input.versionNumber);
    if (version === null) {
      throw formErrors.notFound('表单版本');
    }
    if (version.status !== FormVersionState.PUBLISHED) {
      throw formErrors.preconditionFailed('仅已发布版本可接受提交');
    }

    validateFormAnswer(version.fields, input.values);

    const gate = new CommandIdempotencyGate(
      this.idempotency,
      `submit:${scopeKeyOf(input.scope)}:${input.formId}:${input.versionNumber}:${input.submittedBy}`,
      input.idempotencyKey,
      semanticHashOf({
        formId: input.formId,
        versionNumber: input.versionNumber,
        values: input.values,
      }),
    );
    const begin = await gate.begin();
    if (!begin.proceed) {
      return begin.replay as SubmitFormResult;
    }

    const existing = await this.submissions.loadBySubmitter(
      input.formId,
      input.versionNumber,
      input.submittedBy,
    );
    if (existing !== null) {
      // 该提交者已对当前版本提交：非版本变化，而是提交状态已存在 → 409 IFC-ERR-007
      throw formErrors.stateConflict('该提交者已提交过当前版本，请走修订');
    }

    const id = input.id ?? randomUUID();
    const submission = FormSubmission.createDraft({
      id,
      formId: input.formId,
      versionNumber: input.versionNumber,
      scope: input.scope,
      submittedBy: input.submittedBy,
      values: input.values as Record<string, FormAnswerValue>,
      now: input.now,
    });
    const submitted = submission.submit(new DefaultFormSubmissionStateMachine(), input.now);
    if (!submitted) {
      throw formErrors.stateConflict('提交状态不允许该操作，请刷新后重试');
    }

    await this.submissions.insert(submission.toSnapshot());

    await this.audit.record({
      type: 'FORM_SUBMISSION_CREATED',
      subjectId: id,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId ?? null,
      summary: {
        action: 'SUBMITTED',
        formId: input.formId,
        versionNumber: input.versionNumber,
        submittedBy: input.submittedBy,
      },
    });

    const result: SubmitFormResult = { submissionId: id };
    await gate.finish(result);
    return result;
  }
}
