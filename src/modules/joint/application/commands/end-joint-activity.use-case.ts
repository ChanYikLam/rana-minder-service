/**
 * 结束联合活动用例（JNT-001）。
 */

import { JointActivity } from '../../domain/models/joint-activity';
import { JointActivityStateMachine } from '../../domain/state-machines/joint-activity.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';
import type { JointTaskEnqueuer } from '../../infrastructure/joint-task-enqueuer';

export interface EndJointActivityInput {
  readonly activityId: string;
  readonly actor: string;
  readonly now: Date;
}

export interface EndJointActivityUseCase {
  execute(input: EndJointActivityInput): Promise<void>;
}

export class DefaultEndJointActivityUseCase implements EndJointActivityUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
    private readonly tasks: JointTaskEnqueuer,
  ) {}

  async execute(input: EndJointActivityInput): Promise<void> {
    const activitySnap = await this.repository.loadActivity(input.activityId);
    if (activitySnap === null) {
      throw jointErrors.notFound('联合活动');
    }

    if (
      !(await this.authorization.canManageInvitation({
        activityId: input.activityId,
        subjectId: input.actor,
        action: 'INVITE',
      }))
    ) {
      throw jointErrors.forbidden('仅授权用户可管理邀请阶段');
    }

    const activity = JointActivity.fromSnapshot(activitySnap);
    if (!activity.end(new JointActivityStateMachine(), input.now)) {
      throw jointErrors.preconditionFailed('联合活动结束失败');
    }
    await this.repository.saveActivity(activity.toSnapshot(), activitySnap.revisionNumber);

    await this.tasks.scheduleArchiveTerminal(input.activityId, activitySnap.revisionNumber);
  }
}
