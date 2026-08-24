/**
 * 提交招新申请用例（REC-003、SRS-SM-REC-003）。
 *
 * 校验：授权资格、通道开放、表单提交归属、同一批次唯一性、志愿数量规则。
 */

import { randomUUID } from 'node:crypto';
import { Application } from '../../domain/models/application';
import { DefaultApplicationStateMachine } from '../../domain/state-machines/application.state-machine';
import type { RecruitmentRepository } from '../ports/recruitment-repository.port';
import type { RecruitmentAuthorizationPort } from '../ports/recruitment-authorization.port';
import type { RecruitmentFormPort } from '../ports/recruitment-form.port';
import { recruitmentErrors } from '../errors';

export interface SubmitApplicationFormRef {
  readonly formId: string;
  readonly submissionId: string;
  readonly versionNumber: number;
}

export interface SubmitApplicationInput {
  readonly activityId: string;
  readonly channelId: string;
  readonly applicantId: string;
  readonly departmentChoices: readonly string[];
  readonly formRef?: SubmitApplicationFormRef | null;
  readonly qualifySnapshot?: Record<string, unknown> | null;
  readonly actor: string;
  readonly now: Date;
  readonly id?: string;
}

export interface SubmitApplicationResult {
  readonly applicationId: string;
  readonly revisionNumber: number;
}

export interface SubmitApplicationUseCase {
  execute(input: SubmitApplicationInput): Promise<SubmitApplicationResult>;
}

export class DefaultSubmitApplicationUseCase implements SubmitApplicationUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
    private readonly form: RecruitmentFormPort,
  ) {}

  async execute(input: SubmitApplicationInput): Promise<SubmitApplicationResult> {
    if (input.applicantId !== input.actor) {
      // 申请归属必须绑定认证主体，防止冒充他人提交（AUT 分面）
      throw recruitmentErrors.forbidden('申请归属须为当前认证账号');
    }
    const activity = await this.repository.loadActivity(input.activityId);
    if (activity === null) {
      throw recruitmentErrors.notFound('招新活动');
    }
    if (activity.paused) {
      throw recruitmentErrors.preconditionFailed('招新活动已暂停，暂不接受新报名');
    }
    if (activity.endDate !== null && input.now > activity.endDate) {
      throw recruitmentErrors.preconditionFailed('招新活动报名已截止');
    }
    if (
      !(await this.authorization.canSubmitApplication({
        clubId: activity.clubId,
        subjectId: input.actor,
        activityId: activity.id,
      }))
    ) {
      throw recruitmentErrors.forbidden('当前账号不具备报名资格');
    }
    const channel = await this.repository.loadChannel(input.channelId);
    if (channel === null || channel.activityId !== activity.id) {
      throw recruitmentErrors.notFound('报名通道');
    }
    if (channel.status !== 'OPEN') {
      throw recruitmentErrors.preconditionFailed('报名通道未开放');
    }
    if (input.formRef) {
      const result = await this.form.loadSubmission(input.formRef);
      if (result.outcome === 'forbidden') {
        // 快照存在但归属表单不符：按无权处理，不误报"不存在"（评审意见）
        throw recruitmentErrors.forbidden('关联表单提交归属不符');
      }
      if (result.outcome === 'not-found') {
        // 区分"提交缺失"与"版本已作废"（评审意见：表单修订后旧版本引用应明确提示）
        const message =
          result.reason === 'version-stale'
            ? '关联表单提交版本已作废，请使用最新版本'
            : '关联的表单提交不存在';
        throw recruitmentErrors.validation(message, input.formRef);
      }
      const submission = result.submission;
      if (submission.submittedBy !== input.actor) {
        throw recruitmentErrors.forbidden('表单提交非本人填写');
      }
      if (submission.status !== 'SUBMITTED') {
        throw recruitmentErrors.preconditionFailed('关联的表单提交未定稿');
      }
    }
    const existing = await this.repository.loadApplicationByApplicantAndChannel(
      input.actor,
      input.channelId,
    );
    if (existing !== null) {
      throw recruitmentErrors.conflict('同一报名批次下已存在申请');
    }
    const id = input.id ?? randomUUID();
    const application = Application.createDraft({
      id,
      activityId: activity.id,
      channelId: channel.id,
      clubId: activity.clubId,
      applicantId: input.actor,
      now: input.now,
    });
    const departmentChoices = input.departmentChoices.map((departmentId, index) => ({
      departmentId,
      order: index + 1,
    }));
    const formRef = input.formRef
      ? {
          formId: input.formRef.formId,
          submissionId: input.formRef.submissionId,
          versionNumber: input.formRef.versionNumber,
        }
      : null;
    const submitted = application.submit(new DefaultApplicationStateMachine(), input.now, {
      departmentChoices,
      formRef,
      qualifySnapshot: input.qualifySnapshot,
      minChoices: channel.minChoices,
      maxChoices: channel.maxChoices,
    });
    if (!submitted) {
      throw recruitmentErrors.preconditionFailed('申请提交失败（当前状态不允许）');
    }
    await this.repository.saveApplication(application.toSnapshot(), -1);
    return { applicationId: id, revisionNumber: application.revisionNumber };
  }
}
