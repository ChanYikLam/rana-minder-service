/**
 * 列出招新活动查询（REC-001）。
 *
 * 仅社团负责人/人事可查看本社团招新活动；与命令用例一致注入授权检查。
 */

import type { RecruitmentRepository } from '../ports/recruitment-repository.port';
import type { RecruitmentAuthorizationPort } from '../ports/recruitment-authorization.port';
import { recruitmentErrors } from '../errors';

export interface ListActivitiesInput {
  readonly clubId: string;
  readonly actor: string;
}

export interface ListActivitiesQuery {
  execute(input: ListActivitiesInput): Promise<readonly unknown[]>;
}

export class DefaultListActivitiesQuery implements ListActivitiesQuery {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(input: ListActivitiesInput): Promise<readonly unknown[]> {
    if (
      !(await this.authorization.canManageRecruitment({
        clubId: input.clubId,
        subjectId: input.actor,
      }))
    ) {
      throw recruitmentErrors.forbidden('仅社团负责人/人事可查看招新活动');
    }
    return (await this.repository.loadActivitiesByClub(input.clubId)).map((activity) => ({
      id: activity.id,
      title: activity.title,
      status: activity.status,
      paused: activity.paused,
    }));
  }
}
