/**
 * 列出招新活动查询（REC-001）。
 */

import type { RecruitmentRepository } from '../ports/recruitment-repository.port';

export interface ListActivitiesInput {
  readonly clubId: string;
}

export interface ListActivitiesQuery {
  execute(input: ListActivitiesInput): Promise<readonly unknown[]>;
}

export class DefaultListActivitiesQuery implements ListActivitiesQuery {
  constructor(private readonly repository: RecruitmentRepository) {}

  async execute(input: ListActivitiesInput): Promise<readonly unknown[]> {
    return (await this.repository.loadActivitiesByClub(input.clubId)).map((activity) => ({
      id: activity.id,
      title: activity.title,
      status: activity.status,
      paused: activity.paused,
    }));
  }
}
