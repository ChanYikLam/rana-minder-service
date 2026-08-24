/**
 * 招新活动生命周期用例（REC-001、SRS-SM-REC-001）。
 *
 * 补齐状态机已定义但缺失的 use case（4.4 缺口）：
 * - 暂停（pause）：仅进行中活动；正交标志冻结业务与截止（模型校验）；
 * - 恢复（resume）：仅暂停态；解除标志（顺延逻辑由应用层按暂停时长计算）；
 * - 完成（complete）：OPEN → COMPLETED（状态机）；
 * - 取消（cancel）：DRAFT / OPEN → CANCELLED（状态机）；
 * - 超管强制完成（force-complete）：任意非终态（含暂停/草稿）直接置 COMPLETED，
 *   跳过转换表；授权沿用管理权限（负责人/人事，超管经同一权限端口）。
 *
 * 授权 fail-closed：全部需 canManageRecruitment（club:recruitment:manage）。
 */

import { RecruitmentActivity } from '../../domain/models/recruitment-activity';
import { DefaultRecruitmentActivityStateMachine } from '../../domain/state-machines/recruitment-activity.state-machine';
import type { RecruitmentRepository } from '../ports/recruitment-repository.port';
import type { RecruitmentAuthorizationPort } from '../ports/recruitment-authorization.port';
import { recruitmentErrors } from '../errors';

// ---------- 通用输入/结果 ----------
interface LifecycleInput {
  readonly activityId: string;
  readonly actor: string;
  readonly now: Date;
}

interface LifecycleResult {
  readonly activityId: string;
  readonly status: string;
  readonly paused: boolean;
}

async function loadAndAuthorize(
  repository: RecruitmentRepository,
  authorization: RecruitmentAuthorizationPort,
  input: LifecycleInput,
  action: string,
): Promise<RecruitmentActivity> {
  const snapshot = await repository.loadActivity(input.activityId);
  if (snapshot === null) {
    throw recruitmentErrors.notFound('招新活动');
  }
  if (
    !(await authorization.canManageRecruitment({
      clubId: snapshot.clubId,
      subjectId: input.actor,
      activityId: snapshot.id,
    }))
  ) {
    throw recruitmentErrors.forbidden(`仅社团负责人/人事可${action}招新活动`);
  }
  return RecruitmentActivity.fromSnapshot(snapshot);
}

// ---------- 暂停 ----------
export interface PauseRecruitmentActivityUseCase {
  execute(input: LifecycleInput): Promise<LifecycleResult>;
}

export class DefaultPauseRecruitmentActivityUseCase implements PauseRecruitmentActivityUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(input: LifecycleInput): Promise<LifecycleResult> {
    const activity = await loadAndAuthorize(this.repository, this.authorization, input, '暂停');
    if (activity.status !== 'OPEN') {
      throw recruitmentErrors.preconditionFailed('仅进行中的招新活动可暂停');
    }
    activity.pause(input.now);
    await this.repository.saveActivity(activity.toSnapshot());
    return { activityId: activity.id, status: activity.status, paused: activity.paused };
  }
}

// ---------- 恢复 ----------
export interface ResumeRecruitmentActivityUseCase {
  execute(input: LifecycleInput): Promise<LifecycleResult>;
}

export class DefaultResumeRecruitmentActivityUseCase implements ResumeRecruitmentActivityUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(input: LifecycleInput): Promise<LifecycleResult> {
    const activity = await loadAndAuthorize(this.repository, this.authorization, input, '恢复');
    if (!activity.paused) {
      throw recruitmentErrors.preconditionFailed('招新活动未在暂停状态');
    }
    activity.resume(input.now);
    await this.repository.saveActivity(activity.toSnapshot());
    return { activityId: activity.id, status: activity.status, paused: activity.paused };
  }
}

// ---------- 完成 ----------
export interface CompleteRecruitmentActivityUseCase {
  execute(input: LifecycleInput): Promise<LifecycleResult>;
}

export class DefaultCompleteRecruitmentActivityUseCase implements CompleteRecruitmentActivityUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(input: LifecycleInput): Promise<LifecycleResult> {
    const activity = await loadAndAuthorize(this.repository, this.authorization, input, '完成');
    if (!activity.complete(new DefaultRecruitmentActivityStateMachine(), input.now)) {
      throw recruitmentErrors.preconditionFailed('完成招新活动失败（当前状态不允许）');
    }
    await this.repository.saveActivity(activity.toSnapshot());
    return { activityId: activity.id, status: activity.status, paused: activity.paused };
  }
}

// ---------- 取消 ----------
export interface CancelRecruitmentActivityUseCase {
  execute(input: LifecycleInput): Promise<LifecycleResult>;
}

export class DefaultCancelRecruitmentActivityUseCase implements CancelRecruitmentActivityUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(input: LifecycleInput): Promise<LifecycleResult> {
    const activity = await loadAndAuthorize(this.repository, this.authorization, input, '取消');
    if (!activity.cancel(new DefaultRecruitmentActivityStateMachine(), input.now)) {
      throw recruitmentErrors.preconditionFailed('取消招新活动失败（当前状态不允许）');
    }
    await this.repository.saveActivity(activity.toSnapshot());
    return { activityId: activity.id, status: activity.status, paused: activity.paused };
  }
}

// ---------- 超管强制完成 ----------
export interface ForceCompleteRecruitmentActivityUseCase {
  execute(input: LifecycleInput): Promise<LifecycleResult>;
}

export class DefaultForceCompleteRecruitmentActivityUseCase implements ForceCompleteRecruitmentActivityUseCase {
  constructor(
    private readonly repository: RecruitmentRepository,
    private readonly authorization: RecruitmentAuthorizationPort,
  ) {}

  async execute(input: LifecycleInput): Promise<LifecycleResult> {
    // 强制完成授权沿用管理权限（负责人/人事；超管经同一权限端口判定）
    const activity = await loadAndAuthorize(this.repository, this.authorization, input, '强制完成');
    if (activity.status === 'COMPLETED' || activity.status === 'CANCELLED') {
      throw recruitmentErrors.preconditionFailed('招新活动已处于终态，不可强制完成');
    }
    activity.forceComplete(input.now);
    await this.repository.saveActivity(activity.toSnapshot());
    return { activityId: activity.id, status: activity.status, paused: activity.paused };
  }
}
