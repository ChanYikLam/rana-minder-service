/**
 * 列出联合活动申请用例（JNT-003）。
 */

import type { JointApplicationSnapshot } from '../../domain/models/joint-application';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';

export interface ListJointApplicationsInput {
  readonly activityId: string;
  readonly subjectId: string;
  readonly clubId: string;
}

export interface ListJointApplicationsUseCase {
  execute(input: ListJointApplicationsInput): Promise<JointApplicationSnapshot[]>;
}

export class DefaultListJointApplicationsUseCase implements ListJointApplicationsUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: ListJointApplicationsInput): Promise<JointApplicationSnapshot[]> {
    if (
      !(await this.authorization.canViewApplications({
        subjectId: input.subjectId,
        activityId: input.activityId,
        clubId: input.clubId,
        action: 'VIEW_APPLICATIONS',
      }))
    ) {
      throw jointErrors.forbidden('无权查看该联合活动申请列表');
    }
    return this.repository.loadApplicationsByActivity(input.activityId);
  }
}
