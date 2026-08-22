/**
 * 开放联合报名通道用例（JNT-006）。
 */

import { randomUUID } from 'node:crypto';
import { JointChannel } from '../../domain/models/joint-channel';
import { JointChannelStateMachine } from '../../domain/state-machines/joint-channel.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';
import type { JointTaskEnqueuer } from '../../infrastructure/joint-task-enqueuer';

export interface OpenJointChannelInput {
  readonly jointActivityId: string;
  readonly deadline: Date;
  readonly actor: string;
  readonly now: Date;
  readonly windowId?: string;
}

export interface OpenJointChannelUseCase {
  execute(input: OpenJointChannelInput): Promise<void>;
}

export class DefaultOpenJointChannelUseCase implements OpenJointChannelUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
    private readonly tasks: JointTaskEnqueuer,
  ) {}

  async execute(input: OpenJointChannelInput): Promise<void> {
    if (
      !(await this.authorization.canManageInvitation({
        activityId: input.jointActivityId,
        subjectId: input.actor,
        action: 'INVITE',
      }))
    ) {
      throw jointErrors.forbidden('仅授权用户可开放联合报名通道');
    }

    const existing = await this.repository.loadChannel(
      JointChannel.channelId(input.jointActivityId),
    );
    let channelSnap;
    if (existing === null) {
      const channel = JointChannel.createClosed({
        jointActivityId: input.jointActivityId,
        now: input.now,
      });
      await this.repository.saveChannel(channel.toSnapshot(), -1);
      const saved = await this.repository.loadChannel(
        JointChannel.channelId(input.jointActivityId),
      );
      if (saved === null) {
        throw jointErrors.preconditionFailed('联合报名通道创建失败');
      }
      channelSnap = saved;
    } else {
      channelSnap = existing;
    }

    const channel = JointChannel.fromSnapshot(channelSnap);
    const windowId = input.windowId ?? randomUUID();
    if (
      !channel.open(new JointChannelStateMachine(), {
        windowId,
        deadline: input.deadline,
        now: input.now,
      })
    ) {
      throw jointErrors.preconditionFailed('联合报名通道开放失败');
    }
    await this.repository.saveChannel(channel.toSnapshot(), channelSnap.revisionNumber);

    await this.tasks.scheduleChannelAutoClose(
      input.jointActivityId,
      channelSnap.revisionNumber,
      windowId,
      input.deadline,
    );
  }
}
