/**
 * 获取联合申请用例（JNT-003）。
 */

import type { JointApplicationSnapshot } from '../../domain/models/joint-application';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';

export interface GetJointApplicationInput {
  readonly applicationId: string;
  readonly subjectId: string;
}

export interface GetJointApplicationUseCase {
  execute(input: GetJointApplicationInput): Promise<JointApplicationSnapshot>;
}

export class DefaultGetJointApplicationUseCase implements GetJointApplicationUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: GetJointApplicationInput): Promise<JointApplicationSnapshot> {
    const snap = await this.repository.loadApplication(input.applicationId);
    if (snap === null) {
      throw jointErrors.notFound('联合申请');
    }
    if (snap.applicantId !== input.subjectId) {
      throw jointErrors.forbidden('无权查看该联合申请');
    }
    if (
      !(await this.authorization.canViewApplication({
        subjectId: input.subjectId,
        activityId: snap.jointActivityId,
        applicantId: snap.applicantId,
        action: 'VIEW_APPLICATION',
      }))
    ) {
      throw jointErrors.forbidden('无权查看该联合申请');
    }
    return snap;
  }
}
