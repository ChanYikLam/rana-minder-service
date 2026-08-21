/**
 * 按轮次列出面试记录查询（REC-005）。
 */

import type { RecruitmentRepository } from '../ports/recruitment-repository.port';

export interface ListInterviewsInput {
  readonly roundId: string;
}

export interface ListInterviewsQuery {
  execute(input: ListInterviewsInput): Promise<readonly unknown[]>;
}

export class DefaultListInterviewsQuery implements ListInterviewsQuery {
  constructor(private readonly repository: RecruitmentRepository) {}

  async execute(input: ListInterviewsInput): Promise<readonly unknown[]> {
    return (await this.repository.loadInterviewsByRound(input.roundId)).map((record) => ({
      id: record.id,
      applicationId: record.applicationId,
      applicantId: record.applicantId,
      status: record.status,
      interviewerId: record.interviewerId,
      scheduledAt: record.scheduledAt,
    }));
  }
}
