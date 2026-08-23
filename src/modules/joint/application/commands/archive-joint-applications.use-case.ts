/**
 * 归档联合申请用例（TASK，无授权）。仅已提交申请归档。
 */

import { JointApplication } from '../../domain/models/joint-application';
import { JointApplicationStateMachine } from '../../domain/state-machines/joint-application.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';

export interface ArchiveJointApplicationsInput {
  readonly activityId: string;
  readonly now: Date;
}

export interface ArchiveJointApplicationsUseCase {
  execute(input: ArchiveJointApplicationsInput): Promise<void>;
}

export class DefaultArchiveJointApplicationsUseCase implements ArchiveJointApplicationsUseCase {
  constructor(private readonly repository: JointRepository) {}

  async execute(input: ArchiveJointApplicationsInput): Promise<void> {
    const applicationSnaps = await this.repository.loadApplicationsByActivity(input.activityId);
    for (const snap of applicationSnaps) {
      if (snap.status !== 'SUBMITTED') {
        continue;
      }
      const application = JointApplication.fromSnapshot(snap);
      if (application.archive(new JointApplicationStateMachine(), input.now)) {
        await this.repository.saveApplication(application.toSnapshot(), snap.revisionNumber);
      }
    }
  }
}
