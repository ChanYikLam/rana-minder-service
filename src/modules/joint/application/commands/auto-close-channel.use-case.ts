/**
 * 自动关闭联合报名通道用例（TASK，无授权）。超截止窗口自动关闭。
 */

import { JointChannel } from '../../domain/models/joint-channel';
import { JointChannelStateMachine } from '../../domain/state-machines/joint-channel.state-machine';
import type { JointRepository } from '../ports/joint-repository.port';

export interface AutoCloseChannelInput {
  readonly jointActivityId: string;
  readonly now: Date;
}

export interface AutoCloseChannelResult {
  readonly closed: boolean;
}

export interface AutoCloseChannelUseCase {
  execute(input: AutoCloseChannelInput): Promise<AutoCloseChannelResult>;
}

export class DefaultAutoCloseChannelUseCase implements AutoCloseChannelUseCase {
  constructor(private readonly repository: JointRepository) {}

  async execute(input: AutoCloseChannelInput): Promise<AutoCloseChannelResult> {
    const channelSnap = await this.repository.loadChannel(
      JointChannel.channelId(input.jointActivityId),
    );
    if (channelSnap === null) {
      return { closed: false };
    }
    if (
      channelSnap.status !== 'OPEN' ||
      channelSnap.currentWindow === null ||
      channelSnap.currentWindow.deadline.getTime() > input.now.getTime()
    ) {
      return { closed: false };
    }
    const channel = JointChannel.fromSnapshot(channelSnap);
    if (!channel.close(new JointChannelStateMachine(), input.now)) {
      return { closed: false };
    }
    await this.repository.saveChannel(channel.toSnapshot(), channelSnap.revisionNumber);
    return { closed: true };
  }
}
