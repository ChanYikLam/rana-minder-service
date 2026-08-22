/**
 * 创建联合申请草稿用例（JNT-003）。申请人须为本人。
 */

import { randomUUID } from 'node:crypto';
import { JointApplication } from '../../domain/models/joint-application';
import { JointChannel } from '../../domain/models/joint-channel';
import type { JointRepository } from '../ports/joint-repository.port';
import { jointErrors } from '../errors';

export interface CreateJointApplicationInput {
  readonly jointActivityId: string;
  readonly applicantId: string;
  readonly actor: string;
  readonly now: Date;
  readonly id?: string;
}

export interface CreateJointApplicationResult {
  readonly applicationId: string;
}

export interface CreateJointApplicationUseCase {
  execute(input: CreateJointApplicationInput): Promise<CreateJointApplicationResult>;
}

export class DefaultCreateJointApplicationUseCase implements CreateJointApplicationUseCase {
  constructor(private readonly repository: JointRepository) {}

  async execute(input: CreateJointApplicationInput): Promise<CreateJointApplicationResult> {
    if (input.applicantId !== input.actor) {
      throw jointErrors.forbidden('仅申请人本人可创建联合申请');
    }
    const activitySnap = await this.repository.loadActivity(input.jointActivityId);
    if (activitySnap === null) {
      throw jointErrors.notFound('联合活动');
    }
    if (
      activitySnap.status === 'ENDED' ||
      activitySnap.status === 'CANCELLED' ||
      activitySnap.status === 'FORCE_ENDED'
    ) {
      throw jointErrors.preconditionFailed('终态联合活动不可创建申请');
    }
    if (activitySnap.status !== 'PUBLISHED' && activitySnap.status !== 'INVITING') {
      throw jointErrors.preconditionFailed('仅已公布或邀请阶段的联合活动可创建申请');
    }

    const channelSnap = await this.repository.loadChannel(
      JointChannel.channelId(input.jointActivityId),
    );
    if (channelSnap === null || !JointChannel.fromSnapshot(channelSnap).isOpen(input.now)) {
      throw jointErrors.preconditionFailed('报名通道未开放或已截止，无法创建申请');
    }

    const id = input.id ?? randomUUID();
    const application = JointApplication.createDraft({
      id,
      jointActivityId: input.jointActivityId,
      applicantId: input.applicantId,
      now: input.now,
    });
    await this.repository.saveApplication(application.toSnapshot(), -1);
    return { applicationId: id };
  }
}
