/**
 * 恢复联合报名通道用例（JNT-006）。须设新截止并创建新窗口。
 */

import { randomUUID } from 'node:crypto';
import { JointChannel } from '../../domain/models/joint-channel';
import { JointChannelStateMachine } from '../../domain/state-machines/joint-channel.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import { jointErrors } from '../errors';
import { assertOrgScope } from '../require-org-scope';
import type { JointTaskEnqueuer } from '../../infrastructure/joint-task-enqueuer';

export interface ResumeJointChannelInput {
  readonly jointActivityId: string;
  readonly deadline: Date;
  readonly actingClubId: string;
  readonly actor: string;
  readonly now: Date;
  readonly windowId?: string;
}

export interface ResumeJointChannelUseCase {
  execute(input: ResumeJointChannelInput): Promise<void>;
}

export class DefaultResumeJointChannelUseCase implements ResumeJointChannelUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
    private readonly tasks: JointTaskEnqueuer,
  ) {}

  async execute(input: ResumeJointChannelInput): Promise<void> {
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
    const windowId = input.windowId ?? randomUUID();
    if (
      !channel.resume(new JointChannelStateMachine(), {
        windowId,
        deadline: input.deadline,
        now: input.now,
      })
    ) {
      throw jointErrors.preconditionFailed('联合报名通道恢复失败');
    }
    await this.repository.saveChannel(channel.toSnapshot(), channelSnap.revisionNumber);

    // 恢复新窗口后须调度 auto-close 到新截止，否则新窗口不会被自动关闭。
    await this.tasks.scheduleChannelAutoClose(
      input.jointActivityId,
      channel.toSnapshot().revisionNumber,
      windowId,
      input.deadline,
    );
  }
}
