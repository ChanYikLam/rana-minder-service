/**
 * 暂停联合报名通道用例（JNT-006）。
 */

import { JointChannel } from '../../domain/models/joint-channel';
import { JointChannelStateMachine } from '../../domain/state-machines/joint-channel.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';
import { assertOrgScope } from '../require-org-scope';

export interface SuspendJointChannelInput {
  readonly jointActivityId: string;
  readonly actingClubId: string;
  readonly actor: string;
  readonly now: Date;
}

export interface SuspendJointChannelUseCase {
  execute(input: SuspendJointChannelInput): Promise<void>;
}

export class DefaultSuspendJointChannelUseCase implements SuspendJointChannelUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: SuspendJointChannelInput): Promise<void> {
    if (
      !(await this.authorization.canManageInvitation({
        activityId: input.jointActivityId,
        subjectId: input.actor,
        clubId: input.actingClubId,
        action: 'INVITE',
      }))
    ) {
      throw jointErrors.forbidden('仅授权用户可管理联合报名通道');
    }
    await assertOrgScope(this.repository, input.jointActivityId, input.actingClubId);
    const channelSnap = await this.repository.loadChannel(
      JointChannel.channelId(input.jointActivityId),
    );
    if (channelSnap === null) {
      throw jointErrors.notFound('联合报名通道');
    }
    const channel = JointChannel.fromSnapshot(channelSnap);
    if (!channel.suspend(new JointChannelStateMachine(), input.now)) {
      throw jointErrors.preconditionFailed('联合报名通道暂停失败');
    }
    await this.repository.saveChannel(channel.toSnapshot(), channelSnap.revisionNumber);
  }
}
