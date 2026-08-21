/**
 * 列出招新申请查询（REC-003）。
 */

import type { RecruitmentRepository } from '../ports/recruitment-repository.port';

export interface ListApplicationsInput {
  readonly activityId: string;
}

export interface ListApplicationsQuery {
  execute(input: ListApplicationsInput): Promise<readonly unknown[]>;
}

export class DefaultListApplicationsQuery implements ListApplicationsQuery {
  constructor(private readonly repository: RecruitmentRepository) {}

  async execute(input: ListApplicationsInput): Promise<readonly unknown[]> {
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
