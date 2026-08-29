/**
 * 退出招新用例（A2；SM-REC-003 submitted→exited，接口清单 §11.1）。
 *
 * 守卫（契约错误/备注）：
 * - confirm 非 true → 422（二次确认）；
 * - accepted/admitted 不可退出（须走成员退出流程）；
 * - 仅 SUBMITTED 可退出；退出后未完结面试与待处理邀请按各域状态机收口
 *   （记录保留为不可变历史，不再产生新权益）。
 */

import type { RecruitmentRepository } from '../ports/recruitment-repository.port';
import { Application } from '../../domain/models/application';
import { recruitmentErrors } from '../errors';

export interface ExitRecruitmentInput {
  readonly activityId: string;
  readonly channelId: string;
  readonly applicantId: string;
  readonly confirm: boolean;
  readonly now: Date;
  /** 认证主体（用例内校验 applicantId 归属，防冒充） */
  readonly actor: string;
}

export interface ExitRecruitmentUseCase {
  execute(input: ExitRecruitmentInput): Promise<void>;
}

export class DefaultExitRecruitmentUseCase implements ExitRecruitmentUseCase {
  constructor(private readonly repository: RecruitmentRepository) {}

  async execute(input: ExitRecruitmentInput): Promise<void> {
    if (input.applicantId !== input.actor) {
      throw recruitmentErrors.forbidden('申请归属须为当前认证账号');
    }
    if (input.confirm !== true) {
      throw recruitmentErrors.preconditionFailed('退出招新需要二次确认（confirm=true）');
    }
    const applicationSnapshot = await this.repository.loadApplicationByApplicantAndChannel(
      input.applicantId,
      input.channelId,
    );
    if (applicationSnapshot === null) {
      throw recruitmentErrors.notFound('报名申请');
    }
    if (applicationSnapshot.status === 'ACCEPTED' || applicationSnapshot.status === 'ADMITTED') {
      throw recruitmentErrors.preconditionFailed('已录取成员请走成员退出流程');
    }
    if (applicationSnapshot.status !== 'SUBMITTED') {
      throw recruitmentErrors.preconditionFailed('当前报名状态不可退出招新');
    }

    const application = Application.fromSnapshot(applicationSnapshot);
    if (!application.exit(input.now)) {
      throw recruitmentErrors.preconditionFailed('退出失败（当前状态不允许）');
    }
    await this.repository.saveApplication(
      application.toSnapshot(),
      applicationSnapshot.revisionNumber,
    );
  }
}
