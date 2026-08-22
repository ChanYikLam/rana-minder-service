/**
 * 获取联合活动详情用例（JNT-001）。返回活动、参与社团与通道。
 */

import { JointActivity } from '../../domain/models/joint-activity';
import { JointParticipant } from '../../domain/models/joint-participant';
import { JointChannel } from '../../domain/models/joint-channel';
import type { JointRepository } from '../ports/joint-repository.port';
import { jointErrors } from '../errors';

export interface GetJointActivityInput {
  readonly activityId: string;
}

export interface GetJointActivityResult {
  readonly activity: JointActivity;
  readonly participants: JointParticipant[];
  readonly channel: JointChannel | null;
}

export interface GetJointActivityUseCase {
  execute(input: GetJointActivityInput): Promise<GetJointActivityResult>;
}

export class DefaultGetJointActivityUseCase implements GetJointActivityUseCase {
  constructor(private readonly repository: JointRepository) {}

  async execute(input: GetJointActivityInput): Promise<GetJointActivityResult> {
    const activitySnap = await this.repository.loadActivity(input.activityId);
    if (activitySnap === null) {
      throw jointErrors.notFound('联合活动');
    }
    const participantSnaps = await this.repository.loadParticipantsByActivity(input.activityId);
    const channelSnap = await this.repository.loadChannel(JointChannel.channelId(input.activityId));
    return {
      activity: JointActivity.fromSnapshot(activitySnap),
      participants: participantSnaps.map((s) => JointParticipant.fromSnapshot(s)),
      channel: channelSnap === null ? null : JointChannel.fromSnapshot(channelSnap),
    };
  }
}
