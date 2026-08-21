/**
 * 列出招新申请查询（REC-003）。
 *
 * 仅社团负责人/人事可查看某活动的申请列表（含 applicantId 等内部信息），
 * 与命令用例保持一致地注入授权检查，避免认证链路接入后任意已认证用户读取全量数据。
 */

import type { RecruitmentRepository } from '../ports/recruitment-repository.port';
import type { RecruitmentAuthorizationPort } from '../ports/recruitment-authorization.port';
import { recruitmentErrors } from '../errors';

export interface ListApplicationsInput {
  readonly activityId: string;
  readonly actor: string;
}

export interface ListApplicationsQuery {
  execute(input: ListApplicationsInput): Promise<readonly unknown[]>;
}

export class DefaultListApplicationsQuery implements ListApplicationsQuery {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(input: ListApplicationsInput): Promise<readonly unknown[]> {
    const activity = await this.repository.loadActivity(input.activityId);
    if (activity === null) {
      throw recruitmentErrors.notFound('招新活动');
    }
    if (
      !(await this.authorization.canManageRecruitment({
        clubId: activity.clubId,
        subjectId: input.actor,
        activityId: activity.id,
      }))
    ) {
      throw recruitmentErrors.forbidden('仅社团负责人/人事可查看申请列表');
    }
    return (await this.repository.loadApplicationsByActivity(input.activityId)).map(
      (application) => ({
        id: application.id,
        applicantId: application.applicantId,
        status: application.status,
        revisionNumber: application.revisionNumber,
      }),
    );
  }
}
