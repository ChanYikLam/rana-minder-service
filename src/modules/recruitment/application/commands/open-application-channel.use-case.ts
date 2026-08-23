/**
 * 开放报名通道用例（REC-002、SRS-SM-REC-002）。
 *
 * 活动须进行中；负责人/人事可创建并开放通道（未开放 → 开放）。
 */

import { randomUUID } from 'node:crypto';
import { ApplicationChannel } from '../../domain/models/application-channel';
import { DefaultApplicationChannelStateMachine } from '../../domain/state-machines/application-channel.state-machine';
import type { RecruitmentRepository } from '../ports/recruitment-repository.port';
import type { RecruitmentAuthorizationPort } from '../ports/recruitment-authorization.port';
import { recruitmentErrors } from '../errors';

export interface OpenApplicationChannelInput {
  readonly activityId: string;
  readonly minChoices?: number;
  readonly maxChoices?: number;
  readonly actor: string;
  readonly now: Date;
  readonly id?: string;
}

export interface OpenApplicationChannelResult {
  readonly channelId: string;
}

export interface OpenApplicationChannelUseCase {
  execute(input: OpenApplicationChannelInput): Promise<OpenApplicationChannelResult>;
}

export class DefaultOpenApplicationChannelUseCase implements OpenApplicationChannelUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(input: OpenApplicationChannelInput): Promise<OpenApplicationChannelResult> {
    const activity = await this.repository.loadActivity(input.activityId);
    if (activity === null) {
      throw recruitmentErrors.notFound('招新活动');
    }
    if (activity.status !== 'OPEN') {
      throw recruitmentErrors.preconditionFailed('仅进行中的招新活动可开放报名通道');
    }
    if (activity.paused) {
      throw recruitmentErrors.preconditionFailed('招新活动已暂停，不可开放报名通道');
    }
    if (
      !(await this.authorization.canManageRecruitment({
        clubId: activity.clubId,
        subjectId: input.actor,
        activityId: activity.id,
      }))
    ) {
      throw recruitmentErrors.forbidden('仅社团负责人/人事可配置报名通道');
    }
    const minChoices = input.minChoices ?? 1;
    const maxChoices = input.maxChoices ?? 1;
    if (!Number.isInteger(minChoices) || minChoices < 1) {
      throw recruitmentErrors.validation('志愿下限须为正整数');
    }
    if (!Number.isInteger(maxChoices) || maxChoices < 1) {
      throw recruitmentErrors.validation('志愿上限须为正整数');
    }
    if (minChoices > maxChoices) {
      throw recruitmentErrors.validation('志愿上限不得小于下限');
    }
    const id = input.id ?? randomUUID();
    const channel = ApplicationChannel.createNotStarted({
      id,
      activityId: activity.id,
      clubId: activity.clubId,
      minChoices,
      maxChoices,
      now: input.now,
    });
    if (!channel.open(new DefaultApplicationChannelStateMachine(), input.now)) {
      throw recruitmentErrors.preconditionFailed('报名通道开放失败');
    }
    await this.repository.saveChannel(channel.toSnapshot());
    return { channelId: id };
  }
}
