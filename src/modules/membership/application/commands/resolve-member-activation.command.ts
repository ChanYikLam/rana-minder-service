import { Inject, Injectable } from '@nestjs/common';

import type { MembershipPeriod } from '../../domain/models/membership-period';
import { ActivationExternalPhase, ActivationProgress } from '../../domain/models/membership-period';
import { MembershipPeriodStateMachine } from '../../domain/state-machines/membership-period.state-machine';
import { MEMBERSHIP_CASDOOR_PORT } from '../../infrastructure/casdoor-group.port';
import type { MembershipCasdoorPort } from '../../infrastructure/casdoor-group.port';
import { InMemoryMembershipNotificationPort } from '../../infrastructure/in-memory-stubs';
import { MEMBERSHIP_NOTIFICATION_PORT, saveNotificationFact } from '../ports';
import type { MembershipNotificationPort } from '../ports';
import { MEMBERSHIP_REPOSITORY } from '../../infrastructure/membership-repository';
import type { MembershipRepository } from '../../infrastructure/membership-repository';
import { sanitizeReason } from './sanitize-reason';

/** 激活解析输入（系统关系任务；ORG-027：先回读后重试） */
export interface ResolveMemberActivationInput {
  readonly periodId: string;
  /** 15 分钟仍失败/响应不确定（调用方任务计时传入；由平台调度按 ADR-004 驱动） */
  readonly deadlineExceeded: boolean;
}

/** 激活解析结果 */
export interface ResolveMemberActivationResult {
  readonly period: MembershipPeriod;
  /** 是否已正式生效（以返回经历段的最终状态推导，不假成功） */
  readonly activated: boolean;
}

/** 激活解析前置失败（IFC-ERR-006） */
export class ResolveActivationError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-006: ${message}`);
    this.name = 'ResolveActivationError';
  }
}

/** 激活方向冲突（补偿在途等；IFC-ERR-007，稍后重试） */
export class ActivationBusyError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-007: ${message}`);
    this.name = 'ActivationBusyError';
  }
}

/**
 * 成员身份生效解析（SRS-SM-MEM-001 转换 2/3；REC-026、JNT-016、ORG-027）。
 *
 * - Casdoor 社团＋组合部门/职位 Group 全部写入并**逐项回读确认** → 当前成员：
   原子确认经历实际开始并开放权限（转换 2）；
 * - 仅写入响应成功但未回读、或组合目标未全部确认 → **保持成员生效处理中**，
   不得返回假成功或创建当前成员状态（转换 2 的"保持"分支）；
 * - 15 分钟内失败或响应不确定 → 保持处理中并置失败/重试标志，保持最小权限，
   接受事实不回滚，先回读后重试、无需本人再次接受（转换 3）；
 * - **per-period 方向围栏**：占用 WRITING 相位后才发外部写入；补偿在途时拒绝，
   防止方向相反的外部副作用竞态（同向重入允许，任务崩溃恢复安全）；
 * - 幂等收敛：已生效重复回调直接返回已生效；已被补偿收口的返回未生效；
 * - 单胜者：并发任务比较并交换只一个成功，结果状态以最终落库值推导。
 */
@Injectable()
export class ResolveMemberActivationCommand {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY) private readonly repo: MembershipRepository,
    @Inject(MEMBERSHIP_CASDOOR_PORT) private readonly casdoor: MembershipCasdoorPort,
    @Inject(MEMBERSHIP_NOTIFICATION_PORT)
    private readonly notifications: MembershipNotificationPort = new InMemoryMembershipNotificationPort(),
    private readonly stateMachine: MembershipPeriodStateMachine = new MembershipPeriodStateMachine(),
  ) {}

  async execute(input: ResolveMemberActivationInput): Promise<ResolveMemberActivationResult> {
    const period = await this.repo.load(input.periodId);
    if (period === null) {
      throw new ResolveActivationError('成员经历不存在');
    }
    const activation = period.activation;
    if (activation === null) {
      throw new ResolveActivationError('经历缺少生效意图');
    }
    // 幂等收敛：终态经历不再解析（重复回调/重复任务直接返回当前事实）
    if (period.status === 'CURRENT_MEMBER') {
      return { period, activated: true };
    }
    if (period.status === 'ENTRY_COMPENSATED' || period.status === 'HISTORICAL_MEMBER') {
      return { period, activated: false };
    }
    if (period.status !== 'ACTIVATION_PROCESSING') {
      throw new ResolveActivationError('经历不在成员生效处理中，不能解析激活');
    }

    // 方向围栏：补偿在途时拒绝激活写入（异方向互斥）；占用超 15 分钟允许超时接管，
    // 防止外部写入任务滞留围栏导致本方向无限期 Busy（ORG-027 窗口语义）
    if (activation.phase === ActivationExternalPhase.COMPENSATING) {
      const heldMs =
        activation.fencedAt !== undefined ? Date.now() - Date.parse(activation.fencedAt) : 0;
      if (heldMs < 15 * 60 * 1000) {
        throw new ActivationBusyError('入社补偿正在执行，激活解析稍后重试');
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
            note: '补偿围栏超时释放',
          },
        ],
      };
      const swappedRelease = await this.repo.compareAndSwap(period, released);
      if (!swappedRelease) {
        const latest = await this.repo.load(period.periodId);
        if (latest === null) throw new ResolveActivationError('成员经历不存在');
        return { period: latest, activated: latest.status === 'CURRENT_MEMBER' };
      }
      return this.execute(input);
    }

    const now = new Date().toISOString();

    // 占围栏（WRITING）：与补偿方向互斥；CAS 失败=并发任务已推进，收敛返回最新
    if (activation.phase !== ActivationExternalPhase.WRITING) {
      const fenced: MembershipPeriod = {
        ...period,
        version: period.version + 1,
        activation: {
          ...activation,
          phase: ActivationExternalPhase.WRITING,
          fencedAt: now,
        },
      };
      const swapped = await this.repo.compareAndSwap(period, fenced);
      if (!swapped) {
        const latest = await this.repo.load(period.periodId);
        if (latest === null) throw new ResolveActivationError('成员经历不存在');
        return { period: latest, activated: latest.status === 'CURRENT_MEMBER' };
      }
      return this.writeAndClose(fenced, input, now);
    }
    // 同向重入（WRITING 恢复）：直接续跑外部写入
    return this.writeAndClose(period, input, now);
  }

  /** 在持围栏状态下执行外部写入并收口（转换 2 确认 / 转换 3 保持） */
  private async writeAndClose(
    fenced: MembershipPeriod,
    input: ResolveMemberActivationInput,
    now: string,
  ): Promise<ResolveMemberActivationResult> {
    const activation = fenced.activation as NonNullable<MembershipPeriod['activation']>;
    const idempotencyKey = 'member-activate:' + fenced.periodId;
    let steps: Awaited<ReturnType<MembershipCasdoorPort['addAndReadBack']>>;
    try {
      steps = await this.casdoor.addAndReadBack(
        fenced.clubId,
        fenced.subjectId,
        fenced.entryTargets,
        idempotencyKey,
      );
    } catch (error) {
      // 外部写入异常：释放围栏、留尝试痕迹，保持处理中（不假成功；任务可安全重投）
      return this.releaseOnException(fenced, error);
    }
    const allConfirmed = steps.length > 0 && steps.every((s) => s.ok && s.confirmed);

    if (allConfirmed) {
      // 转换 2：原子确认实际开始与当前关系版本；重复回调不产生第二次开始
      const updated: MembershipPeriod = {
        ...fenced,
        version: fenced.version + 1,
        status: this.stateMachine.transition('ACTIVATION_PROCESSING', 'CURRENT_MEMBER'),
        actualStartAt: fenced.actualStartAt ?? now,
        activation: {
          ...activation,
          progress: ActivationProgress.PROCESSING,
          phase: ActivationExternalPhase.PENDING,
          lastAttemptAt: now,
          lastError: undefined,
        },
        history: [
          ...fenced.history,
          { at: now, type: 'ACTIVATION_CONFIRMED', by: 'system', note: 'steps=' + steps.length },
        ],
      };
      return this.close(fenced, updated, true);
    }

    // 未全部确认：保持处理中（15 分钟内）或带失败/重试标志（转换 3）
    const firstFailure = steps.find((s) => !(s.ok && s.confirmed));
    const nextProgress =
      input.deadlineExceeded || activation.progress === ActivationProgress.FAILED_PENDING_RETRY
        ? ActivationProgress.FAILED_PENDING_RETRY
        : ActivationProgress.PROCESSING;
    const updated: MembershipPeriod = {
      ...fenced,
      version: fenced.version + 1,
      status: 'ACTIVATION_PROCESSING', // 自环：失败/重试标志
      activation: {
        ...activation,
        progress: nextProgress,
        phase: ActivationExternalPhase.PENDING, // 释放围栏
        attemptCount: activation.attemptCount + 1,
        lastAttemptAt: now,
        lastError: sanitizeReason(
          firstFailure?.reason ?? 'casdoor-write-readback-not-all-confirmed',
        ),
      },
      history: [
        ...fenced.history,
        { at: now, type: 'ACTIVATION_RETRY_KEPT_PROCESSING', by: 'system' },
      ],
    };
    return this.close(fenced, updated, false);
  }

  /** 外部写入异常兜底：CAS 释放围栏回 PENDING 并留痕；释放失败则以最新态收敛返回 */
  private async releaseOnException(
    fenced: MembershipPeriod,
    error: unknown,
  ): Promise<ResolveMemberActivationResult> {
    const act = fenced.activation as NonNullable<MembershipPeriod['activation']>;
    const reason = sanitizeReason(error instanceof Error ? error.message : String(error));
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
        lastError: reason,
      },
      history: [
        ...fenced.history,
        {
          at: new Date().toISOString(),
          type: 'ACTIVATION_RETRY_KEPT_PROCESSING',
          by: 'system',
          note: '外部写入异常，围栏已释放',
        },
      ],
    };
    const swapped = await this.repo.compareAndSwap(fenced, released);
    if (swapped) return { period: released, activated: false };
    const latest = await this.repo.load(fenced.periodId);
    if (latest === null) throw new ResolveActivationError('成员经历不存在');
    return { period: latest, activated: latest.status === 'CURRENT_MEMBER' };
  }

  /** 收口提交：单胜者 CAS；竞争失败重载最新并以最终状态推导 activated（不假成功） */
  private async close(
    current: MembershipPeriod,
    next: MembershipPeriod,
    confirmedNow: boolean,
  ): Promise<ResolveMemberActivationResult> {
    const swapped = await this.repo.compareAndSwap(current, next);
    let finalPeriod = next;
    if (!swapped) {
      const latest = await this.repo.load(current.periodId);
      if (latest === null) throw new ResolveActivationError('成员经历不存在');
      finalPeriod = latest; // 以最终落库状态推导结果（ORG-027）
    }
    const activated = finalPeriod.status === 'CURRENT_MEMBER';
    if (activated && confirmedNow) {
      await saveNotificationFact(this.notifications, {
        kind: 'MEMBER_ACTIVATED',
        toUserIds: [finalPeriod.subjectId],
        clubId: finalPeriod.clubId,
        dedupKey: 'MEMBER_ACTIVATED:' + finalPeriod.periodId,
        title: '成员身份已生效',
        body: '社团关系同步完成，成员权限已开放。',
      });
    }
    return { period: finalPeriod, activated };
  }
}
