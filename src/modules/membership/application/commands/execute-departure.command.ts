import { Inject, Injectable } from '@nestjs/common';

import type {
  MemberDepartureState,
  MembershipPeriod,
  MembershipRelationTarget,
} from '../../domain/models/membership-period';
import { DepartureExecution, DepartureRequestStatus } from '../../domain/models/membership-period';
import { MembershipPeriodStateMachine } from '../../domain/state-machines/membership-period.state-machine';
import { MembershipPolicy } from '../../domain/services/membership-policy';
import {
  InMemoryMembershipAccessPort,
  InMemoryMembershipNotificationPort,
} from '../../infrastructure/in-memory-stubs';
import {
  MEMBERSHIP_ACCESS_PORT,
  MEMBERSHIP_NOTIFICATION_PORT,
  saveNotificationFact,
} from '../ports';
import type { MembershipAccessPort } from '../ports';
import type { MembershipNotificationPort } from '../ports';
import { MEMBERSHIP_CASDOOR_PORT } from '../../infrastructure/casdoor-group.port';
import type { MembershipCasdoorPort } from '../../infrastructure/casdoor-group.port';
import { MEMBERSHIP_REPOSITORY } from '../../infrastructure/membership-repository';
import type { MembershipRepository } from '../../infrastructure/membership-repository';
import { sanitizeReason } from './sanitize-reason';

/** 退出执行输入（系统关系任务；人工重试由调用方以操作者身份触发，权限服务端重算） */
export interface ExecuteDepartureInput {
  readonly periodId: string;
  /** 自动重试已达 15 分钟上限（调用方任务计时传入；由平台调度按 ADR-004 驱动） */
  readonly deadlineExceeded: boolean;
  /** 人工重试（ORG-027：重新鉴权且不重复审批决定） */
  readonly manualRetry?: boolean;
  /** 人工重试操作者（manualRetry 时必填；角色按当前 Group 服务端重算） */
  readonly actorId?: string;
}

/** 退出执行结果 */
export interface ExecuteDepartureResult {
  readonly period: MembershipPeriod;
  /** 经历是否已结束（社团范围全部 Group 移除并回读确认） */
  readonly ended: boolean;
  /** 是否已恢复当前成员（转换 7：失败收口且原关系完整有效） */
  readonly restoredToCurrent: boolean;
}

/** 执行前置失败（IFC-ERR-003/006） */
export class ExecuteDepartureError extends Error {
  constructor(code: 'IFC-ERR-003' | 'IFC-ERR-006', message: string) {
    super(`${code}: ${message}`);
    this.name = 'ExecuteDepartureError';
  }
}

/**
 * 退出执行（SRS-SM-MEM-001 转换 6/7；MEM-002/005/008、ORG-027/030）。
 *
 * - 级联移除 Casdoor 社团＋快照内**全部**部门/职位 Group，逐项回读；
 * - **收口前全量自查**（转换 6 前置 + ORG-030）：回读枚举该成员在该社团范围
   当前仍存在的全部 Group 关系——非空即残留（含快照遗漏项），不得结束经历，
   标记残留异常并保持退出处理中，防止非成员保留子级权限；
 * - 全部确认移除 → **历史成员**：原子记录经历实际结束、撤销当前访问；
   其他社团关系不受影响（本命令只操作本社团范围）；
 * - 自动重试收口为失败（deadlineExceeded）时：先回读确认原关系仍完整有效，
   完整 → **恢复当前成员**（转换 7），保留决定与权限；无法确认 → 保持处理中；
 * - **人工重试重新鉴权**（角色经 MembershipAccessPort 服务端重算）且不重复审批决定；
 * - 幂等键按经历段固定：级联步骤逐项幂等，同一经历只结束一次。
 */
@Injectable()
export class ExecuteDepartureCommand {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY) private readonly repo: MembershipRepository,
    @Inject(MEMBERSHIP_CASDOOR_PORT) private readonly casdoor: MembershipCasdoorPort,
    private readonly policy: MembershipPolicy,
    @Inject(MEMBERSHIP_ACCESS_PORT)
    private readonly access: MembershipAccessPort = new InMemoryMembershipAccessPort(),
    @Inject(MEMBERSHIP_NOTIFICATION_PORT)
    private readonly notifications: MembershipNotificationPort = new InMemoryMembershipNotificationPort(),
    private readonly stateMachine: MembershipPeriodStateMachine = new MembershipPeriodStateMachine(),
  ) {}

  async execute(input: ExecuteDepartureInput): Promise<ExecuteDepartureResult> {
    const period = await this.repo.load(input.periodId);
    if (period === null) {
      throw new ExecuteDepartureError('IFC-ERR-006', '成员经历不存在');
    }
    const departure = period.departure;
    if (departure === null || departure.requestStatus !== DepartureRequestStatus.APPROVED) {
      throw new ExecuteDepartureError('IFC-ERR-006', '缺少已批准的退出/移除决定');
    }
    if (departure.execution === DepartureExecution.COMPLETED) {
      // 同一经历只结束一次：重复任务幂等返回
      return { period, ended: period.status === 'HISTORICAL_MEMBER', restoredToCurrent: false };
    }

    const resumingFromRestore =
      period.status === 'CURRENT_MEMBER' &&
      departure.execution === DepartureExecution.FAILED_RESTORED;
    if (period.status !== 'DEPARTURE_PROCESSING' && !resumingFromRestore) {
      throw new ExecuteDepartureError('IFC-ERR-006', '经历不在退出处理中，不能执行退出级联');
    }

    // 失败恢复（转换 7）后仅允许人工重试继续：自动重试窗口已收口，
    // 继续执行必须重新鉴权（ORG-027：人工重试重新鉴权且不重复审批决定）
    if (resumingFromRestore && input.manualRetry !== true) {
      throw new ExecuteDepartureError(
        'IFC-ERR-006',
        '执行失败已恢复当前成员，仅允许负责人/人事人工重试继续（ORG-027）',
      );
    }

    // 人工重试重新鉴权：操作者角色按当前 Group 服务端重算（ORG-038/ORG-027）
    if (input.manualRetry === true) {
      if (input.actorId === undefined) {
        throw new ExecuteDepartureError('IFC-ERR-006', '人工重试必须提供操作者');
      }
      const actorRoles = await this.access.operatorRolesAt(period.clubId, input.actorId);
      this.policy.assertCanRetryDeparture([...actorRoles]);
    }

    // 恢复态续跑：先按状态机走"当前成员 → 退出处理中"（转换 5 边）落座，再统一执行级联
    let basePeriod = period;
    if (resumingFromRestore) {
      const reentered: MembershipPeriod = {
        ...basePeriod,
        version: basePeriod.version + 1,
        status: this.stateMachine.transition('CURRENT_MEMBER', 'DEPARTURE_PROCESSING'),
        history: [
          ...basePeriod.history,
          {
            at: new Date().toISOString(),
            type: 'DEPARTURE_RETRY_KEPT_PROCESSING',
            by: input.actorId ?? 'system',
            note: '人工重试继续退出级联',
          },
        ],
      };
      const swappedReentry = await this.repo.compareAndSwap(basePeriod, reentered);
      if (!swappedReentry) {
        throw new ExecuteDepartureError(
          'IFC-ERR-006',
          '成员经历已被并发变更，人工重试失败，请重试',
        );
      }
      basePeriod = reentered;
    }

    const now = new Date().toISOString();
    // 社团 Group ＋ 快照内全部部门/职位 Group
    const targets: MembershipRelationTarget[] = [
      { kind: 'CLUB', refId: basePeriod.clubId },
      ...departure.snapshot,
    ];
    // 业务幂等键按经历段固定：人工重试不换键、不重复审批决定
    const idempotencyKey = 'member-depart:' + period.periodId;
    const steps = await this.casdoor.removeAllAndReadBack(
      basePeriod.clubId,
      basePeriod.subjectId,
      targets,
      idempotencyKey,
    );
    const allRemovedConfirmed = steps.length > 0 && steps.every((s) => s.ok && s.confirmed);

    if (allRemovedConfirmed) {
      // 收口前全量自查（转换 6 前置 + ORG-030）：社团范围内不得残留任何关系
      const remaining = await this.casdoor.listActiveRelationTargets(
        period.clubId,
        period.subjectId,
      );
      if (remaining.length > 0) {
        const retryingResidual: MembershipPeriod = {
          ...basePeriod,
          version: basePeriod.version + 1,
          status: this.stateMachine.transition('DEPARTURE_PROCESSING', 'DEPARTURE_PROCESSING'),
          hasResidualAnomaly: true, // 残留标记异常；不自动改写外部，继续回读/重试
          departure: {
            ...departure,
            attemptCount: departure.attemptCount + 1,
            lastError: sanitizeReason(
              '残留目标关系未确认移除：' + remaining.map((r) => r.kind + ':' + r.refId).join(','),
            ),
          },
          history: [
            ...basePeriod.history,
            { at: now, type: 'DEPARTURE_RETRY_KEPT_PROCESSING', by: 'system' },
          ],
        };
        const swappedResidual = await this.repo.compareAndSwap(basePeriod, retryingResidual);
        const latestResidual = swappedResidual
          ? retryingResidual
          : await this.repo.load(period.periodId);
        if (latestResidual === null)
          throw new ExecuteDepartureError('IFC-ERR-006', '成员经历不存在');
        return { period: latestResidual, ended: false, restoredToCurrent: false };
      }

      // 转换 6：原子记录实际结束＋撤销访问（其他社团不在本命令范围内）
      const endedDeparture: MemberDepartureState = {
        ...departure,
        execution: DepartureExecution.COMPLETED,
        attemptCount: departure.attemptCount + 1,
      };
      const ended: MembershipPeriod = {
        ...basePeriod,
        version: basePeriod.version + 1,
        status: this.stateMachine.transition(basePeriod.status, 'HISTORICAL_MEMBER'),
        hasResidualAnomaly: false, // 全量自查通过：残留异常标记清除（N9）
        actualEndAt: now,
        departure: endedDeparture,
        history: [
          ...basePeriod.history,
          {
            at: now,
            type: 'PERIOD_ENDED',
            by: 'system',
            note: '全部 Group 移除并回读确认（steps=' + steps.length + '）',
          },
        ],
      };
      const swapped = await this.repo.compareAndSwap(basePeriod, ended);
      if (!swapped) {
        const latest = await this.repo.load(basePeriod.periodId);
        if (latest === null) throw new ExecuteDepartureError('IFC-ERR-006', '成员经历不存在');
        return {
          period: latest,
          ended: latest.status === 'HISTORICAL_MEMBER',
          restoredToCurrent: false,
        };
      }
      await saveNotificationFact(this.notifications, {
        kind: 'MEMBER_DEPARTURE_COMPLETED',
        toUserIds: [basePeriod.subjectId],
        clubId: basePeriod.clubId,
        dedupKey: 'MEMBER_DEPARTURE_COMPLETED:' + period.periodId,
        title: '退出完成',
        body: '该社团全部关系与访问权限已移除；历史经历保留，可随时查看时间线。',
      });
      return { period: ended, ended: true, restoredToCurrent: false };
    }

    // 存在未确认移除的目标
    const firstFailure = steps.find((s) => !(s.ok && s.confirmed));
    if (input.deadlineExceeded === true) {
      // 转换 7 前置：必须先回读确认"原关系完整有效"才可恢复当前成员
      const intact = await this.casdoor.confirmRelationsIntact(
        period.clubId,
        period.subjectId,
        targets,
      );
      if (intact) {
        const restoredDeparture: MemberDepartureState = {
          ...departure,
          execution: DepartureExecution.FAILED_RESTORED,
          attemptCount: departure.attemptCount + 1,
          lastError: sanitizeReason(
            firstFailure?.reason ?? 'cascade-remove-failed-original-intact',
          ),
          restoredAt: now,
        };
        const restored: MembershipPeriod = {
          ...basePeriod,
          version: basePeriod.version + 1,
          status: this.stateMachine.transition(basePeriod.status, 'CURRENT_MEMBER'),
          hasResidualAnomaly: false, // 原关系确认完整：异常标记清除
          departure: restoredDeparture,
          history: [
            ...basePeriod.history,
            { at: now, type: 'EXIT_EXECUTION_FAILED_RESTORED', by: 'system' },
          ],
        };
        const swapped = await this.repo.compareAndSwap(basePeriod, restored);
        if (!swapped) {
          const latest = await this.repo.load(basePeriod.periodId);
          if (latest === null) throw new ExecuteDepartureError('IFC-ERR-006', '成员经历不存在');
          return {
            period: latest,
            ended: false,
            restoredToCurrent: latest.status === 'CURRENT_MEMBER',
          };
        }
        await saveNotificationFact(this.notifications, {
          kind: 'MEMBER_DEPARTURE_EXECUTION_FAILED',
          toUserIds: [basePeriod.subjectId],
          clubId: basePeriod.clubId,
          dedupKey:
            'MEMBER_DEPARTURE_EXECUTION_FAILED:' +
            period.periodId +
            ':' +
            (departure.attemptCount + 1),
          title: '退出执行失败，已恢复成员状态',
          body: '原关系与权限保持有效；请负责人/人事人工重试或联系管理员。',
        });
        return { period: restored, ended: false, restoredToCurrent: true };
      }
      // 无法确认原关系完整：不得恢复当前成员，保持处理中（调用方进入同步异常）
    }

    // 保持退出处理中：保存尝试痕迹，继续回读/重试
    const retrying: MembershipPeriod = {
      ...basePeriod,
      version: basePeriod.version + 1,
      status: this.stateMachine.transition('DEPARTURE_PROCESSING', 'DEPARTURE_PROCESSING'),
      departure: {
        ...departure,
        attemptCount: departure.attemptCount + 1,
        lastError: sanitizeReason(firstFailure?.reason ?? 'cascade-remove-not-all-confirmed'),
      },
      history: [
        ...basePeriod.history,
        { at: now, type: 'DEPARTURE_RETRY_KEPT_PROCESSING', by: 'system' },
      ],
    };
    const swapped = await this.repo.compareAndSwap(basePeriod, retrying);
    if (!swapped) {
      const latest = await this.repo.load(basePeriod.periodId);
      if (latest === null) throw new ExecuteDepartureError('IFC-ERR-006', '成员经历不存在');
      return { period: latest, ended: false, restoredToCurrent: false };
    }
    return { period: retrying, ended: false, restoredToCurrent: false };
  }
}
