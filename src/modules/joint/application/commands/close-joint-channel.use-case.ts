/**
 * 关闭联合报名通道用例（JNT-006）。
 */

import { JointChannel } from '../../domain/models/joint-channel';
import { JointChannelStateMachine } from '../../domain/state-machines/joint-channel.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';

export interface CloseJointChannelInput {
  readonly jointActivityId: string;
  readonly actor: string;
  readonly now: Date;
}

export interface CloseJointChannelUseCase {
  execute(input: CloseJointChannelInput): Promise<void>;
}

export class DefaultCloseJointChannelUseCase implements CloseJointChannelUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: CloseJointChannelInput): Promise<void> {
    if (
      !(await this.authorization.canManageInvitation({
        activityId: input.jointActivityId,
        subjectId: input.actor,
        action: 'INVITE',
      }))
    ) {
      throw jointErrors.forbidden('仅授权用户可管理联合报名通道');
    }
    const channelSnap = await this.repository.loadChannel(
      JointChannel.channelId(input.jointActivityId),
    );
    if (channelSnap === null) {
      throw jointErrors.notFound('联合报名通道');
    }
    const channel = JointChannel.fromSnapshot(channelSnap);
    if (!channel.close(new JointChannelStateMachine(), input.now)) {
      throw jointErrors.preconditionFailed('联合报名通道关闭失败');
    }
    await this.repository.saveChannel(channel.toSnapshot(), channelSnap.revisionNumber);
  }
}
