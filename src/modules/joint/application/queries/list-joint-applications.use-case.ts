/**
 * 列出联合活动申请用例（JNT-003）。
 */

import type { JointApplicationSnapshot } from '../../domain/models/joint-application';
import type { JointRepository } from '../ports/joint-repository.port';

export interface ListJointApplicationsInput {
  readonly activityId: string;
}

export interface ListJointApplicationsUseCase {
  execute(input: ListJointApplicationsInput): Promise<JointApplicationSnapshot[]>;
}

export class DefaultListJointApplicationsUseCase implements ListJointApplicationsUseCase {
  constructor(private readonly repository: JointRepository) {}

  async execute(input: ListJointApplicationsInput): Promise<JointApplicationSnapshot[]> {
    return this.repository.loadApplicationsByActivity(input.activityId);
  }
}
