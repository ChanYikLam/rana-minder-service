import { Inject, Injectable, Optional } from '@nestjs/common';

import type { MembershipPeriod } from '../../domain/models/membership-period';
import { ActivationExternalPhase, ActivationProgress } from '../../domain/models/membership-period';
import { MembershipPeriodStateMachine } from '../../domain/state-machines/membership-period.state-machine';
import { MEMBERSHIP_CASDOOR_PORT } from '../../infrastructure/casdoor-group.port';
import type { MembershipCasdoorPort } from '../../infrastructure/casdoor-group.port';
import { InMemoryMembershipNotificationPort } from '../../infrastructure/in-memory-stubs';
import {
  MEMBERSHIP_NOTIFICATION_PORT,
  MEMBERSHIP_GROUP_OBSERVATION_PORT,
  saveNotificationFact,
  safeSyncObservation,
  type MembershipGroupObservationPort,
} from '../ports';
import type { MembershipNotificationPort } from '../ports';
import { sanitizeReason } from './sanitize-reason';
import { MEMBERSHIP_REPOSITORY } from '../../infrastructure/membership-repository';
import type { MembershipRepository } from '../../infrastructure/membership-repository';

/** 补偿输入（系统关系任务；SRS-SM-MEM-001 转换 4） */
export interface CompensateMemberActivationInput {
  readonly periodId: string;
}

/** 补偿结果 */
export interface CompensateMemberActivationResult {
  readonly period: MembershipPeriod;
  /** 补偿是否已收口（全部已写入 Group 移除并回读确认） */
  readonly compensated: boolean;
}

/** 补偿前置失败（IFC-ERR-006） */
export class CompensateActivationError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-006: ${message}`);
    this.name = 'CompensateActivationError';
  }
}

/** 补偿方向冲突（激活写入在途；IFC-ERR-007，稍后重试） */
export class CompensationBusyError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-007: ${message}`);
    this.name = 'CompensationBusyError';
  }
}

/**
 * 入社补偿（SRS-SM-MEM-001 转换 4；ORG-027、MEM-018）。
 *
 * 触发条件（由调用方任务判定）：组合写入部分成功、回读确认仅部分关系写入，
 * 且领域要求恢复接受前的非成员状态。
 *
 * - 对全部组合目标**逐项幂等移除并回读**；全部确认 → ENTRY_COMPENSATED：
   关闭本次当前成员生效，草稿作废；**接受/任命历史不删除**（历史事件保留）；
   主体对外呈现非成员（首次）或保持历史成员（重入，MEM-013）；
 * - 任一补偿步骤未确认 → **不得转非成员**：保持处理中，由调用方进入高优先级异常；
 * - **per-period 方向围栏**：占用 COMPENSATING 相位后才发外部移除；激活写入在途时拒绝，
   防止方向相反的外部副作用竞态（同向重入允许，任务崩溃恢复安全）；
 * - 幂等收敛：已补偿收口的重复任务返回已补偿；已生效经历禁止补偿（走退出/移除）；
 * - 单胜者：并发补偿任务比较并交换只一个成功（IFC-GEN-007）。
 */
@Injectable()
export class CompensateMemberActivationCommand {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY) private readonly repo: MembershipRepository,
    @Inject(MEMBERSHIP_CASDOOR_PORT) private readonly casdoor: MembershipCasdoorPort,
    @Inject(MEMBERSHIP_NOTIFICATION_PORT)
    private readonly notifications: MembershipNotificationPort = new InMemoryMembershipNotificationPort(),
    /** A4 Group 写链路收口：激活确认后同步组织域关系观测（可选；缺省跳过） */
    @Optional()
    @Inject(MEMBERSHIP_GROUP_OBSERVATION_PORT)
    private readonly groupObservation?: MembershipGroupObservationPort,
    private readonly stateMachine: MembershipPeriodStateMachine = new MembershipPeriodStateMachine(),
  ) {}

  /** 外部移除异常兜底：CAS 释放围栏回 PENDING 并留痕；释放失败则以最新态收敛返回 */
  private async releaseOnException(
    fenced: MembershipPeriod,
    error: unknown,
  ): Promise<CompensateMemberActivationResult> {
    const act = fenced.activation as NonNullable<MembershipPeriod['activation']>;
    const reason = error instanceof Error ? error.message : String(error);
    const released: MembershipPeriod = {
      ...fenced,
      version: fenced.version + 1,
      status: 'ACTIVATION_PROCESSING',
      activation: {
        ...act,
        phase: ActivationExternalPhase.PENDING,
        progress: ActivationProgress.FAILED_PENDING_RETRY,
        attemptCount: act.attemptCount + 1,
        lastAttemptAt: new Date().toISOString(),
        lastError: sanitizeReason(reason),
      },
      history: [
        ...fenced.history,
        {
          at: new Date().toISOString(),
          type: 'ACTIVATION_RETRY_KEPT_PROCESSING',
          by: 'system',
          note: '补偿外部移除异常，围栏已释放',
        },
      ],
    };
    const swapped = await this.repo.compareAndSwap(fenced, released);
    if (swapped) return { period: released, compensated: false };
    const latest = await this.repo.load(fenced.periodId);
    if (latest === null) throw new CompensateActivationError('成员经历不存在');
    return { period: latest, compensated: latest.status === 'ENTRY_COMPENSATED' };
  }

  async execute(input: CompensateMemberActivationInput): Promise<CompensateMemberActivationResult> {
    const period = await this.repo.load(input.periodId);
    if (period === null) {
      throw new CompensateActivationError('成员经历不存在');
    }
    // 幂等收敛：已补偿收口的重复任务直接返回（不重复外部调用、不重复追加历史）
    if (period.status === 'ENTRY_COMPENSATED') {
      return { period, compensated: true };
    }
    if (period.status !== 'ACTIVATION_PROCESSING') {
      throw new CompensateActivationError('仅成员生效处理中的经历可补偿');
    }
    if (period.actualStartAt !== null) {
      // 已回读确认生效的经历不得走入社补偿：应走退出/移除流程（MEM-002/008）
      throw new CompensateActivationError(
        '经历已回读确认生效，不能补偿为非成员，应走退出/移除流程',
      );
    }
    const activation = period.activation;
    if (activation === null) {
      throw new CompensateActivationError('经历缺少生效意图');
    }

    // 方向围栏：激活写入在途时拒绝补偿（异方向互斥）；占用超 15 分钟允许超时接管，
    // 防止外部写入任务滞留围栏导致补偿无限期 Busy（ORG-027 窗口语义）
    if (activation.phase === ActivationExternalPhase.WRITING) {
      const heldMs =
        activation.fencedAt !== undefined ? Date.now() - Date.parse(activation.fencedAt) : 0;
      if (heldMs < 15 * 60 * 1000) {
        throw new CompensationBusyError('成员激活写入正在执行，补偿稍后重试');
      }
      const released: MembershipPeriod = {
        ...period,
        version: period.version + 1,
        activation: { ...activation, phase: ActivationExternalPhase.PENDING },
        history: [
          ...period.history,
          {
            at: new Date().toISOString(),
            type: 'ACTIVATION_RETRY_KEPT_PROCESSING',
            by: 'system',
            note: '激活围栏超时释放',
          },
        ],
      };
      const swappedRelease = await this.repo.compareAndSwap(period, released);
      if (!swappedRelease) {
        const latest = await this.repo.load(period.periodId);
        if (latest === null) throw new CompensateActivationError('成员经历不存在');
        return { period: latest, compensated: latest.status === 'ENTRY_COMPENSATED' };
      }
      return this.execute(input);
    }

    const now = new Date().toISOString();
    let fenced = period;
    if (activation.phase !== ActivationExternalPhase.COMPENSATING) {
      const nextFence: MembershipPeriod = {
        ...period,
        version: period.version + 1,
        activation: {
          ...activation,
          phase: ActivationExternalPhase.COMPENSATING,
          fencedAt: now,
        },
      };
      const swapped = await this.repo.compareAndSwap(period, nextFence);
      if (!swapped) {
        const latest = await this.repo.load(period.periodId);
        if (latest === null) throw new CompensateActivationError('成员经历不存在');
        return { period: latest, compensated: latest.status === 'ENTRY_COMPENSATED' };
      }
      fenced = nextFence;
    }

    // 逐项幂等移除并回读（同一经历段补偿键固定，重复执行安全）
    const idempotencyKey = 'member-activate-compensate:' + period.periodId;
    let steps: Awaited<ReturnType<MembershipCasdoorPort['removeAllAndReadBack']>>;
    try {
      steps = await this.casdoor.removeAllAndReadBack(
        fenced.clubId,
        fenced.subjectId,
        fenced.entryTargets,
        idempotencyKey,
      );
    } catch (error) {
      // 外部移除异常：释放围栏、留尝试痕迹，保持处理中（不假成功；任务可安全重投）
      return this.releaseOnException(fenced, error);
    }
    const allConfirmed = steps.length > 0 && steps.every((s) => s.ok && s.confirmed);

    const act = fenced.activation as NonNullable<MembershipPeriod['activation']>;
    if (!allConfirmed) {
      // 补偿未确认：置失败/重试标志并保持处理中（调用方进入高优先级异常），
      // 绝不假成功；释放围栏；失败原因脱敏后落库（与 resolve/异常路径口径一致）
      const firstFailure = steps.find((s) => !(s.ok && s.confirmed));
      const updated: MembershipPeriod = {
        ...fenced,
        version: fenced.version + 1,
        status: 'ACTIVATION_PROCESSING',
        activation: {
          ...act,
          phase: ActivationExternalPhase.PENDING,
          progress: ActivationProgress.FAILED_PENDING_RETRY,
          attemptCount: act.attemptCount + 1,
          lastAttemptAt: now,
          lastError: sanitizeReason(firstFailure?.reason ?? 'compensation-readback-not-confirmed'),
        },
        history: [
          ...fenced.history,
          {
            at: now,
            type: 'ACTIVATION_RETRY_KEPT_PROCESSING',
            by: 'system',
            note: '补偿未确认，保持处理中',
          },
        ],
      };
      const swapped = await this.repo.compareAndSwap(fenced, updated);
      const latest = swapped ? updated : await this.repo.load(period.periodId);
      if (latest === null) throw new CompensateActivationError('成员经历不存在');
      return { period: latest, compensated: false };
    }

    // 补偿收口：草稿作废（从未成为当前成员）；接受/任命历史保留；释放围栏
    const compensated: MembershipPeriod = {
      ...fenced,
      version: fenced.version + 1,
      status: this.stateMachine.transition('ACTIVATION_PROCESSING', 'ENTRY_COMPENSATED'),
      activation: { ...act, phase: ActivationExternalPhase.PENDING },
      history: [
        ...fenced.history,
        {
          at: now,
          type: 'ENTRY_COMPENSATED',
          by: 'system',
          note:
            '组合写入部分成功，全部新增 Group 已补偿移除并回读确认（steps=' + steps.length + '）',
        },
      ],
    };
    const swapped = await this.repo.compareAndSwap(fenced, compensated);
    if (!swapped) {
      const latest = await this.repo.load(period.periodId);
      if (latest === null) throw new CompensateActivationError('成员经历不存在');
      return { period: latest, compensated: latest.status === 'ENTRY_COMPENSATED' };
    }
    // A4 Group 写链路收口：补偿移除全部确认 → 清除该主体在该社团的关系观测
    await safeSyncObservation(this.groupObservation, () =>
      this.groupObservation!.clearOnDepartureConfirmed(fenced.clubId, fenced.subjectId),
    );
    await saveNotificationFact(this.notifications, {
      kind: 'MEMBER_ENTRY_COMPENSATED',
      toUserIds: [fenced.subjectId],
      clubId: fenced.clubId,
      dedupKey: 'MEMBER_ENTRY_COMPENSATED:' + fenced.periodId,
      title: '入社同步未完成，已恢复原状态',
      body: '本次接受事实与记录保留；如需加入请重新发起。',
    });
    return { period: compensated, compensated: true };
  }
}
