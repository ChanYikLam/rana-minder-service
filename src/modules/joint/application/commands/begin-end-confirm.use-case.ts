/**
 * 进入结束确认用例（JNT-001）。须处于邀请阶段。
 */

import { JointActivity } from '../../domain/models/joint-activity';
import { JointActivityStateMachine } from '../../domain/state-machines/joint-activity.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';

export interface BeginEndConfirmInput {
  readonly activityId: string;
  readonly actor: string;
  readonly now: Date;
}

export interface BeginEndConfirmUseCase {
  execute(input: BeginEndConfirmInput): Promise<void>;
}

export class DefaultBeginEndConfirmUseCase implements BeginEndConfirmUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: BeginEndConfirmInput): Promise<void> {
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

    if (activitySnap.status !== 'INVITING') {
      throw jointErrors.preconditionFailed('仅邀请阶段的联合活动可进入结束确认');
    }

    const activity = JointActivity.fromSnapshot(activitySnap);
    if (!activity.beginEndConfirm(new JointActivityStateMachine(), input.now)) {
      throw jointErrors.preconditionFailed('进入结束确认失败');
    }
    await this.repository.saveActivity(activity.toSnapshot(), activitySnap.revisionNumber);
  }
}
