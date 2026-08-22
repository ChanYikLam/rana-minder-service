/**
 * 记录联合面试评价用例（JNT-004）。评价为 append-only。
 */

import { JointInterview } from '../../domain/models/joint-interview';
import type { JointRepository } from '../ports/joint-repository.port';
import { jointErrors } from '../errors';

export interface RecordJointEvaluationInput {
  readonly interviewId: string;
  readonly clubId: string;
  readonly interviewerId: string;
  readonly values: Record<string, unknown>;
  readonly now: Date;
}

export interface RecordJointEvaluationUseCase {
  execute(input: RecordJointEvaluationInput): Promise<void>;
}

export class DefaultRecordJointEvaluationUseCase implements RecordJointEvaluationUseCase {
  constructor(private readonly repository: JointRepository) {}

  async execute(input: RecordJointEvaluationInput): Promise<void> {
    const interviewSnap = await this.repository.loadInterview(input.interviewId);
    if (interviewSnap === null) {
      throw jointErrors.notFound('联合面试');
    }
    const interview = JointInterview.fromSnapshot(interviewSnap);
    interview.addEvaluation(input.clubId, input.interviewerId, input.values, input.now);
    await this.repository.saveInterview(interview.toSnapshot(), interviewSnap.revisionNumber);
  }
}
