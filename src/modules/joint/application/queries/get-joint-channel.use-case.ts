/**
 * 获取联合报名通道用例（JNT-006）。
 */

import { JointChannel } from '../../domain/models/joint-channel';
import type { JointRepository } from '../ports/joint-repository.port';
import { jointErrors } from '../errors';

export interface GetJointChannelInput {
  readonly jointActivityId: string;
}

export interface GetJointChannelUseCase {
  execute(input: GetJointChannelInput): Promise<JointChannel>;
}

export class DefaultGetJointChannelUseCase implements GetJointChannelUseCase {
  constructor(private readonly repository: JointRepository) {}

  async execute(input: GetJointChannelInput): Promise<JointChannel> {
    const snap = await this.repository.loadChannel(JointChannel.channelId(input.jointActivityId));
    if (snap === null) {
      throw jointErrors.notFound('联合报名通道');
    }
    return JointChannel.fromSnapshot(snap);
  }
}
