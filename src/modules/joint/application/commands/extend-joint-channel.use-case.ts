/**
 * 延长联合报名通道用例（JNT-006）。仅延长当前窗口截止。
 */

import { JointChannel } from '../../domain/models/joint-channel';
import { JointChannelStateMachine } from '../../domain/state-machines/joint-channel.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';
import { assertOrgScope } from '../require-org-scope';

export interface ExtendJointChannelInput {
  readonly jointActivityId: string;
  readonly deadline: Date;
  readonly actingClubId: string;
  readonly actor: string;
  readonly now: Date;
}

export interface ExtendJointChannelUseCase {
  execute(input: ExtendJointChannelInput): Promise<void>;
}

export class DefaultExtendJointChannelUseCase implements ExtendJointChannelUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: ExtendJointChannelInput): Promise<void> {
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
    if (
      !channel.extend(new JointChannelStateMachine(), { deadline: input.deadline, now: input.now })
    ) {
      throw jointErrors.preconditionFailed('联合报名通道延长失败');
    }
    await this.repository.saveChannel(channel.toSnapshot(), channelSnap.revisionNumber);
  }
}
