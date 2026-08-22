/**
 * 重开联合报名通道用例（JNT-006）。非终态活动可重开新窗口。
 */

import { randomUUID } from 'node:crypto';
import { JointChannel } from '../../domain/models/joint-channel';
import { JointChannelStateMachine } from '../../domain/state-machines/joint-channel.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';
import { assertOrgScope } from '../require-org-scope';

export interface ReopenJointChannelInput {
  readonly jointActivityId: string;
  readonly deadline: Date;
  readonly actingClubId: string;
  readonly actor: string;
  readonly now: Date;
  readonly windowId?: string;
}

export interface ReopenJointChannelUseCase {
  execute(input: ReopenJointChannelInput): Promise<void>;
}

export class DefaultReopenJointChannelUseCase implements ReopenJointChannelUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: ReopenJointChannelInput): Promise<void> {
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
      !channel.reopen(new JointChannelStateMachine(), {
        windowId: input.windowId ?? randomUUID(),
        deadline: input.deadline,
        now: input.now,
      })
    ) {
      throw jointErrors.preconditionFailed('联合报名通道重开失败');
    }
    await this.repository.saveChannel(channel.toSnapshot(), channelSnap.revisionNumber);
  }
}
