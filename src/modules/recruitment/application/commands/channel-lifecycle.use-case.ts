/**
 * 报名通道生命周期用例（REC-002、SRS-SM-REC-002）。
 *
 * 补齐通道命令（4.4 缺口；open-application-channel 仅覆盖首次开放）：
 * - 暂停（pause）：仅开放中；暂停停新报名与申请人修改，已安排面试/评审继续；
 * - 恢复（resume）：仅暂停态 → 开放；
 * - 关闭（close）：OPEN/PAUSED → CLOSED（记录关闭时刻）；
 * - 重开新窗口（reopen）：CLOSED → OPEN，须携新截止且严格晚于重开提交时刻
 *   （SRS-SM-REC-002 守卫），区别于首次开放。
 *
 * 活动整体暂停期间冻结通道业务（拒绝全部通道操作）；授权 fail-closed：
 * canManageRecruitment（负责人/人事）。
 */

import { ApplicationChannel } from '../../domain/models/application-channel';
import { DefaultApplicationChannelStateMachine } from '../../domain/state-machines/application-channel.state-machine';
import type { RecruitmentRepository } from '../ports/recruitment-repository.port';
import type { RecruitmentAuthorizationPort } from '../ports/recruitment-authorization.port';
import { recruitmentErrors } from '../errors';

// ---------- 通用：加载通道 + 活动冻结校验 + 授权 ----------
async function loadChannelAndAuthorize(
  repository: RecruitmentRepository,
  authorization: RecruitmentAuthorizationPort,
  channelId: string,
  actor: string,
  action: string,
): Promise<{ channel: ApplicationChannel; activityId: string }> {
  const channelSnapshot = await repository.loadChannel(channelId);
  if (channelSnapshot === null) {
    throw recruitmentErrors.notFound('报名通道');
  }
  const activity = await repository.loadActivity(channelSnapshot.activityId);
  if (activity === null) {
    throw recruitmentErrors.notFound('招新活动');
  }
  if (activity.paused) {
    throw recruitmentErrors.preconditionFailed('招新活动已暂停，通道业务冻结');
  }
  if (
    !(await authorization.canManageRecruitment({
      clubId: activity.clubId,
      subjectId: actor,
      activityId: activity.id,
    }))
  ) {
    throw recruitmentErrors.forbidden(`仅社团负责人/人事可${action}报名通道`);
  }
  return { channel: ApplicationChannel.fromSnapshot(channelSnapshot), activityId: activity.id };
}

interface ChannelResult {
  readonly channelId: string;
  readonly status: string;
  readonly closeAt: string | null;
}

function resultOf(channel: ApplicationChannel): ChannelResult {
  return {
    channelId: channel.id,
    status: channel.status,
    closeAt: channel.closeAt?.toISOString() ?? null,
  };
}

// ---------- 暂停 ----------
export interface PauseApplicationChannelUseCase {
  execute(input: {
    readonly channelId: string;
    readonly actor: string;
    readonly now: Date;
  }): Promise<ChannelResult>;
}

export class DefaultPauseApplicationChannelUseCase implements PauseApplicationChannelUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(input: {
    readonly channelId: string;
    readonly actor: string;
    readonly now: Date;
  }): Promise<ChannelResult> {
    const { channel } = await loadChannelAndAuthorize(
      this.repository,
      this.authorization,
      input.channelId,
      input.actor,
      '暂停',
    );
    if (channel.status !== 'OPEN') {
      throw recruitmentErrors.preconditionFailed('仅开放中的报名通道可暂停');
    }
    channel.pause(input.now);
    await this.repository.saveChannel(channel.toSnapshot());
    return resultOf(channel);
  }
}

// ---------- 恢复 ----------
export interface ResumeApplicationChannelUseCase {
  execute(input: {
    readonly channelId: string;
    readonly actor: string;
    readonly now: Date;
  }): Promise<ChannelResult>;
}

export class DefaultResumeApplicationChannelUseCase implements ResumeApplicationChannelUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(input: {
    readonly channelId: string;
    readonly actor: string;
    readonly now: Date;
  }): Promise<ChannelResult> {
    const { channel } = await loadChannelAndAuthorize(
      this.repository,
      this.authorization,
      input.channelId,
      input.actor,
      '恢复',
    );
    if (channel.status !== 'PAUSED') {
      throw recruitmentErrors.preconditionFailed('报名通道未在暂停状态');
    }
    channel.resume(input.now);
    await this.repository.saveChannel(channel.toSnapshot());
    return resultOf(channel);
  }
}

// ---------- 关闭 ----------
export interface CloseApplicationChannelUseCase {
  execute(input: {
    readonly channelId: string;
    readonly actor: string;
    readonly now: Date;
  }): Promise<ChannelResult>;
}

export class DefaultCloseApplicationChannelUseCase implements CloseApplicationChannelUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(input: {
    readonly channelId: string;
    readonly actor: string;
    readonly now: Date;
  }): Promise<ChannelResult> {
    const { channel } = await loadChannelAndAuthorize(
      this.repository,
      this.authorization,
      input.channelId,
      input.actor,
      '关闭',
    );
    if (!channel.close(new DefaultApplicationChannelStateMachine(), input.now)) {
      throw recruitmentErrors.preconditionFailed('关闭报名通道失败（当前状态不允许）');
    }
    await this.repository.saveChannel(channel.toSnapshot());
    return resultOf(channel);
  }
}

// ---------- 重开新窗口 ----------
export interface ReopenApplicationChannelInput {
  readonly channelId: string;
  /** 新窗口截止：须严格晚于重开提交时刻（SRS-SM-REC-002 守卫） */
  readonly newDeadline: Date;
  readonly actor: string;
  readonly now: Date;
}

export interface ReopenApplicationChannelUseCase {
  execute(input: ReopenApplicationChannelInput): Promise<ChannelResult>;
}

export class DefaultReopenApplicationChannelUseCase implements ReopenApplicationChannelUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(input: ReopenApplicationChannelInput): Promise<ChannelResult> {
    const { channel } = await loadChannelAndAuthorize(
      this.repository,
      this.authorization,
      input.channelId,
      input.actor,
      '重开',
    );
    if (channel.status !== 'CLOSED') {
      throw recruitmentErrors.preconditionFailed('仅已关闭的报名通道可重开新窗口');
    }
    if (input.newDeadline.getTime() <= input.now.getTime()) {
      throw recruitmentErrors.validation('新窗口截止须严格晚于当前时刻');
    }
    // Critical 修复：必须调用 reopen()（CLOSED → OPEN 原子转换 + 新截止持久化到
    // deadline）；open() 仅在首次开放设置 openAt、从不写 deadline
    if (
      !channel.reopen(new DefaultApplicationChannelStateMachine(), input.newDeadline, input.now)
    ) {
      throw recruitmentErrors.preconditionFailed('重开报名通道失败（新截止守卫不满足）');
    }
    await this.repository.saveChannel(channel.toSnapshot());
    return resultOf(channel);
  }
}
