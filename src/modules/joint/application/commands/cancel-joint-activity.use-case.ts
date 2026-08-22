/**
 * 取消联合活动用例（JNT-001）。仅首邀前可取消。
 */

import { JointActivity } from '../../domain/models/joint-activity';
import { JointActivityStateMachine } from '../../domain/state-machines/joint-activity.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';
import type { JointTaskEnqueuer } from '../../infrastructure/joint-task-enqueuer';
import { assertOrgScope } from '../require-org-scope';

export interface CancelJointActivityInput {
  readonly activityId: string;
  readonly actingClubId: string;
  readonly actor: string;
  readonly now: Date;
}

export interface CancelJointActivityUseCase {
  execute(input: CancelJointActivityInput): Promise<void>;
}

export class DefaultCancelJointActivityUseCase implements CancelJointActivityUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
    private readonly tasks: JointTaskEnqueuer,
  ) {}

  async execute(input: CancelJointActivityInput): Promise<void> {
    const activitySnap = await this.repository.loadActivity(input.activityId);
    if (activitySnap === null) {
      throw jointErrors.notFound('联合活动');
    }

    await assertOrgScope(this.repository, input.activityId, input.actingClubId);

    if (
      !(await this.authorization.canCancelOrForceEnd({
        activityId: input.activityId,
        subjectId: input.actor,
        clubId: input.actingClubId,
        action: 'CANCEL',
      }))
    ) {
      throw jointErrors.forbidden('仅授权用户可取消联合活动');
    }

    const activity = JointActivity.fromSnapshot(activitySnap);
    if (!activity.cancelAll(new JointActivityStateMachine(), input.now)) {
      throw jointErrors.preconditionFailed('联合活动取消失败');
    }
    await this.repository.saveActivity(activity.toSnapshot(), activitySnap.revisionNumber);

    await this.tasks.scheduleArchiveTerminal(
      input.activityId,
      activity.toSnapshot().revisionNumber,
    );
  }
}
