/**
 * 发布招新活动用例（REC-001）。
 *
 * 负责人/人事创建活动后将其发布（DRAFT → OPEN），发布后方可开放报名通道。
 * 仅进行中活动可开放通道（open-application-channel 校验 activity.status === OPEN）。
 * 授权 fail-closed：仅负责人/人事可发布。
 */

import { RecruitmentActivity } from '../../domain/models/recruitment-activity';
import { DefaultRecruitmentActivityStateMachine } from '../../domain/state-machines/recruitment-activity.state-machine';
import type { RecruitmentRepository } from '../ports/recruitment-repository.port';
import type { RecruitmentAuthorizationPort } from '../ports/recruitment-authorization.port';
import { recruitmentErrors } from '../errors';

export interface PublishRecruitmentActivityInput {
  readonly activityId: string;
  readonly actor: string;
  readonly now: Date;
}

export interface PublishRecruitmentActivityResult {
  readonly activityId: string;
  readonly status: string;
}

export interface PublishRecruitmentActivityUseCase {
  execute(input: PublishRecruitmentActivityInput): Promise<PublishRecruitmentActivityResult>;
}

export class DefaultPublishRecruitmentActivityUseCase
  implements PublishRecruitmentActivityUseCase
{
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(
    input: PublishRecruitmentActivityInput,
  ): Promise<PublishRecruitmentActivityResult> {
    const snapshot = await this.repository.loadActivity(input.activityId);
    if (snapshot === null) {
      throw recruitmentErrors.notFound('招新活动');
    }
    if (
      !(await this.authorization.canManageRecruitment({
        clubId: snapshot.clubId,
        subjectId: input.actor,
        activityId: snapshot.id,
      }))
    ) {
      throw recruitmentErrors.forbidden('仅社团负责人/人事可发布招新活动');
    }
    const activity = RecruitmentActivity.fromSnapshot(snapshot);
    if (!activity.open(new DefaultRecruitmentActivityStateMachine(), input.now)) {
      throw recruitmentErrors.preconditionFailed('发布招新活动失败（当前状态不允许）');
    }
    await this.repository.saveActivity(activity.toSnapshot());
    return { activityId: activity.id, status: activity.status };
  }
}
