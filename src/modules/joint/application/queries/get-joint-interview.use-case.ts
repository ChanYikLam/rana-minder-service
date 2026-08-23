/**
 * 获取联合面试用例（JNT-004）。
 */

import type { JointInterviewSnapshot } from '../../domain/models/joint-interview';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';

export interface GetJointInterviewInput {
  readonly interviewId: string;
  readonly subjectId: string;
}

export interface GetJointInterviewUseCase {
  execute(input: GetJointInterviewInput): Promise<JointInterviewSnapshot>;
}

export class DefaultGetJointInterviewUseCase implements GetJointInterviewUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: GetJointInterviewInput): Promise<JointInterviewSnapshot> {
    const snap = await this.repository.loadInterview(input.interviewId);
    if (snap === null) {
      throw jointErrors.notFound('联合面试');
    }
    const applicationSnap = await this.repository.loadApplication(snap.jointApplicationId);
    if (applicationSnap === null) {
      throw jointErrors.notFound('联合申请');
    }
    if (applicationSnap.applicantId !== input.subjectId) {
      throw jointErrors.forbidden('无权查看该联合面试');
    }
    if (
      !(await this.authorization.canViewInterview({
        subjectId: input.subjectId,
        activityId: applicationSnap.jointActivityId,
        applicantId: applicationSnap.applicantId,
        action: 'VIEW_INTERVIEW',
      }))
    ) {
      throw jointErrors.forbidden('无权查看该联合面试');
    }
    return snap;
  }
}
