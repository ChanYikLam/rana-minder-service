/**
 * 修订提交用例（FORM-002、DATA-FRM-001/002）。
 *
 * 已提交记录（SUBMITTED）方可修订；修订前重验答案、校验填写权限，追加修订快照并
 * 以修订号乐观守卫保存（并发修订单胜者 → IFC-ERR-008）。
 */

import { FormSubmission, type FormAnswerValue } from '../../domain/models/form-submission';
import { DefaultFormSubmissionStateMachine } from '../../domain/state-machines/form-submission.state-machine';
import {
  validateFormAnswer,
  stripHiddenFieldValues,
} from '../../domain/services/form-answer.validator';
import { FormVersionState } from '../../domain/state-machines/form-version.state-machine';
import type { FormDefinitionRepository } from '../ports/form-definition-repository.port';
import type { FormSubmissionRepository } from '../ports/form-submission-repository.port';
import type { FormFillPermissionPort } from '../ports/form-fill-permission.port';
import type { FormAuditPort } from '../ports/form-audit.port';
import { formErrors } from '../errors';

export interface ReviseSubmissionInput {
  readonly submissionId: string;
  readonly revisedBy: string;
  readonly values: Record<string, unknown>;
  readonly actor: string;
  readonly now: Date;
  readonly traceId?: string | null;
}

export interface ReviseSubmissionResult {
  readonly submissionId: string;
  readonly revisionNumber: number;
}

export interface ReviseSubmissionUseCase {
  execute(input: ReviseSubmissionInput): Promise<ReviseSubmissionResult>;
}

export class DefaultReviseSubmissionUseCase implements ReviseSubmissionUseCase {
  constructor(
    private readonly submissions: FormSubmissionRepository,
    private readonly definitions: FormDefinitionRepository,
    private readonly fillPermission: FormFillPermissionPort,
    private readonly audit: FormAuditPort,
  ) {}

  async execute(input: ReviseSubmissionInput): Promise<ReviseSubmissionResult> {
    const snapshot = await this.submissions.load(input.submissionId);
    if (snapshot === null) {
      throw formErrors.notFound('表单提交');
    }
    const submission = FormSubmission.fromSnapshot(snapshot);

    const fill = await this.fillPermission.canFill({
      formId: submission.formId,
      versionNumber: submission.versionNumber,
      scope: submission.scope,
      subjectId: input.actor,
    });
    if (!fill.allowed) {
      throw formErrors.forbidden(fill.reason ?? '无权修订该提交');
    }

    const version = await this.definitions.loadVersion(submission.formId, submission.versionNumber);
    if (version === null) {
      // 修订需要按原版本字段重验答案；版本定义缺失则无法校验
      throw formErrors.notFound('表单版本');
    }
    // 修订是对既有已提交内容的纠错，不因版本后续停用而追溯性剥夺
    // （DEPRECATED 只阻止新提交，既有提交与附件保留）；DRAFT/PREVIEW_TESTING
    // 表示该版本从未正式发布过，不存在可修订的历史提交。
    if (
      version.status !== FormVersionState.PUBLISHED &&
      version.status !== FormVersionState.DEPRECATED
    ) {
      throw formErrors.preconditionFailed('目标表单版本不可修订');
    }

    validateFormAnswer(version.fields, input.values);
    // 落库前剔除 hidden 字段值，防止客户端注入服务端隐藏字段（DATA-FRM-003）
    const sanitized = stripHiddenFieldValues(version.fields, input.values);

    const machine = new DefaultFormSubmissionStateMachine();
    if (!submission.canRevise(machine)) {
      throw formErrors.preconditionFailed('仅已提交记录可修订');
    }
    const expectedRevision = submission.revisionNumber;
    const revised = submission.revise(
      sanitized as Record<string, FormAnswerValue>,
      input.actor,
      input.now,
      machine,
    );
    if (!revised) {
      throw formErrors.preconditionFailed('修订失败（状态不允许）');
    }

    await this.submissions.save(submission.toSnapshot(), expectedRevision);

    await this.audit.record({
      type: 'FORM_SUBMISSION_REVISED',
      subjectId: submission.id,
      occurredAt: input.now,
      actor: input.actor,
      traceId: input.traceId ?? null,
      summary: {
        action: 'REVISED',
        formId: submission.formId,
        versionNumber: submission.versionNumber,
        revisionNumber: submission.revisionNumber,
        revisedBy: input.actor,
      },
    });

    return { submissionId: submission.id, revisionNumber: submission.revisionNumber };
  }
}
