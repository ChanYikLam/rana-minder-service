/**
 * 记录联合面试评价用例（JNT-004）。评价为 append-only。
 */

import { JointInterview } from '../../domain/models/joint-interview';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';

export interface RecordJointEvaluationInput {
  readonly interviewId: string;
  readonly clubId: string;
  readonly values: Record<string, unknown>;
  readonly subjectId: string;
  readonly now: Date;
}

export interface RecordJointEvaluationUseCase {
  execute(input: RecordJointEvaluationInput): Promise<void>;
}

export class DefaultRecordJointEvaluationUseCase implements RecordJointEvaluationUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: RecordJointEvaluationInput): Promise<void> {
    const interviewSnap = await this.repository.loadInterview(input.interviewId);
    if (interviewSnap === null) {
      throw jointErrors.notFound('联合面试');
    }
    const applicationSnap = await this.repository.loadApplication(interviewSnap.jointApplicationId);
    if (applicationSnap === null) {
      throw jointErrors.notFound('联合申请');
    }
    if (
      !(await this.authorization.canRecordEvaluation({
        subjectId: input.subjectId,
        activityId: applicationSnap.jointActivityId,
        clubId: input.clubId,
        action: 'RECORD_EVALUATION',
      }))
    ) {
      throw jointErrors.forbidden('无权代表该社团记录联合面试评价');
    }
    const interview = JointInterview.fromSnapshot(interviewSnap);
    interview.addEvaluation(input.clubId, input.subjectId, input.values, input.now);
    await this.repository.saveInterview(interview.toSnapshot(), interviewSnap.revisionNumber);
  }
}
