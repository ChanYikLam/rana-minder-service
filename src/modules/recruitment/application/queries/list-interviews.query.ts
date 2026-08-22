/**
 * 按轮次列出面试记录查询（REC-005）。
 *
 * 仅社团负责人/人事可查看面试记录；从轮次内面试记录解析 activity 后做授权检查，
 * 与命令用例保持一致，避免认证链路接入后任意已认证用户读取面试数据。
 */

import type { RecruitmentRepository } from '../ports/recruitment-repository.port';
import type { RecruitmentAuthorizationPort } from '../ports/recruitment-authorization.port';
import { recruitmentErrors } from '../errors';

export interface ListInterviewsInput {
  readonly roundId: string;
  readonly actor: string;
}

export interface ListInterviewsQuery {
  execute(input: ListInterviewsInput): Promise<readonly unknown[]>;
}

export class DefaultListInterviewsQuery implements ListInterviewsQuery {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(input: ListInterviewsInput): Promise<readonly unknown[]> {
    const records = await this.repository.loadInterviewsByRound(input.roundId);
    const first = records[0];
    if (first !== undefined) {
      const activity = await this.repository.loadActivity(first.activityId);
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
        throw recruitmentErrors.forbidden('仅社团负责人/人事可查看面试记录');
      }
    }
    return records.map((record) => ({
      id: record.id,
      applicationId: record.applicationId,
      applicantId: record.applicantId,
      status: record.status,
      interviewerId: record.interviewerId,
      scheduledAt: record.scheduledAt,
    }));
  }
}
