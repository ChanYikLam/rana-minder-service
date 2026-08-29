/**
 * 撤销提交回草稿用例（A2；SM-REC-003 submitted→draft，接口清单 §11.1）。
 *
 * 守卫（契约错误/备注）：
 * - 仅通道开放且未截止可撤销；
 * - 已有未完结面试安排（PENDING_SELECTION/SELECTED/SCHEDULED/IN_PROGRESS/ON_HOLD）
 *   或已有面试结论（COMPLETED）→ 422；
 * - 撤销后 paths 清空（department_paths 的路径语义随申请状态失效，此处通过
 *   状态机进入 WITHDRAWN 达成——路径记录保留为不可变历史，不再参与评价）。
 *
 * 面试记录删除/邀请过期联动：领域规则上由 interview/invitation 域各自状态机
 * 收口（记录保留为历史）；本用例只做申请主体转换与守卫。
 */

import { Application } from '../../domain/models/application';
import type { RecruitmentRepository } from '../ports/recruitment-repository.port';
import { recruitmentErrors } from '../errors';

export interface WithdrawApplicationInput {
  readonly activityId: string;
  readonly channelId: string;
  readonly applicantId: string;
  readonly now: Date;
  /** 认证主体（用例内校验 applicantId 归属，防冒充） */
  readonly actor: string;
}

export interface WithdrawApplicationResult {
  readonly applicationId: string;
}

export interface WithdrawApplicationUseCase {
  execute(input: WithdrawApplicationInput): Promise<WithdrawApplicationResult>;
}

/** 未完结面试状态（存在任一即不可撤销） */
const BLOCKING_INTERVIEW_STATUSES = new Set([
  'PENDING_SELECTION',
  'SELECTED',
  'SCHEDULED',
  'IN_PROGRESS',
  'ON_HOLD',
]);

/** 已产出结论的面试状态（存在任一即不可撤销） */
const CONCLUDED_INTERVIEW_STATUSES = new Set(['COMPLETED']);

export class DefaultWithdrawApplicationUseCase implements WithdrawApplicationUseCase {
  constructor(private readonly repository: RecruitmentRepository) {}

  async execute(input: WithdrawApplicationInput): Promise<WithdrawApplicationResult> {
    if (input.applicantId !== input.actor) {
      throw recruitmentErrors.forbidden('申请归属须为当前认证账号');
    }
    const applicationSnapshot = await this.repository.loadApplicationByApplicantAndChannel(
      input.applicantId,
      input.channelId,
    );
    if (applicationSnapshot === null) {
      throw recruitmentErrors.notFound('报名申请');
    }
    if (applicationSnapshot.status !== 'SUBMITTED') {
      throw recruitmentErrors.preconditionFailed('当前报名状态不可撤销');
    }

    const channel = await this.repository.loadChannel(input.channelId);
    if (
      channel === null ||
      channel.status !== 'OPEN' ||
      (channel.deadline !== null && input.now.getTime() > channel.deadline.getTime())
    ) {
      throw recruitmentErrors.preconditionFailed('报名通道未开放或已截止，不可撤销');
    }

    const interviews = await this.repository.loadInterviewsByApplication(applicationSnapshot.id);
    const hasBlocking = interviews.some((i) => BLOCKING_INTERVIEW_STATUSES.has(i.status));
    if (hasBlocking) {
      throw recruitmentErrors.preconditionFailed('已有面试安排，不可撤销提交');
    }
    const hasConclusion = interviews.some((i) => CONCLUDED_INTERVIEW_STATUSES.has(i.status));
    if (hasConclusion) {
      throw recruitmentErrors.preconditionFailed('面试已产生结论，不可撤销提交');
    }

    const application = Application.fromSnapshot(applicationSnapshot);
    if (!application.withdraw(input.now)) {
      throw recruitmentErrors.preconditionFailed('申请撤销失败（当前状态不允许）');
    }
    await this.repository.saveApplication(
      application.toSnapshot(),
      applicationSnapshot.revisionNumber,
    );
    return { applicationId: application.id };
  }
}
