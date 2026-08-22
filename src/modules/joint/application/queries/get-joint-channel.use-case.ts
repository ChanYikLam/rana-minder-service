/**
 * 获取联合报名通道用例（JNT-006）。
 */

import { JointChannel } from '../../domain/models/joint-channel';
import type { JointAuthorizationPort } from '../ports/joint-authorization.port';
import type { JointRepository } from '../ports/joint-repository.port';
import { jointErrors } from '../errors';

export interface GetJointChannelInput {
  readonly jointActivityId: string;
  readonly subjectId: string;
  readonly clubId?: string;
}

export interface GetJointChannelUseCase {
  execute(input: GetJointChannelInput): Promise<JointChannel>;
}

export class DefaultGetJointChannelUseCase implements GetJointChannelUseCase {
  constructor(
    private readonly repository: JointRepository,
    private readonly authorization: JointAuthorizationPort,
  ) {}

  async execute(input: GetJointChannelInput): Promise<JointChannel> {
    const snap = await this.repository.loadChannel(JointChannel.channelId(input.jointActivityId));
    if (snap === null) {
      throw jointErrors.notFound('联合报名通道');
    }
    const activitySnap = await this.repository.loadActivity(input.jointActivityId);
    if (activitySnap === null) {
      throw jointErrors.notFound('联合活动');
    }
    const clubId = input.clubId;
    if (
      !(await this.authorization.canViewChannel({
        subjectId: input.subjectId,
        activityId: input.jointActivityId,
        clubId,
        action: 'VIEW_CHANNEL',
      }))
    ) {
      throw jointErrors.forbidden('无权查看该联合报名通道');
    }
    return JointChannel.fromSnapshot(snap);
  }
}
