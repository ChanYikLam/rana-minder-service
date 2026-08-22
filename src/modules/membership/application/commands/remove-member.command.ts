import { Inject, Injectable } from '@nestjs/common';

import type {
  MemberDepartureState,
  MembershipPeriod,
  MembershipRelationTarget,
} from '../../domain/models/membership-period';
import {
  DepartureExecution,
  DepartureKind,
  DepartureRequestStatus,
} from '../../domain/models/membership-period';
import { LastOwnerContinuityPolicy } from '../../../organization/domain/services/last-owner-continuity.policy';
import { MembershipPeriodStateMachine } from '../../domain/state-machines/membership-period.state-machine';
import { MembershipPolicy } from '../../domain/services/membership-policy';
import { InMemoryMembershipAccessPort } from '../../infrastructure/in-memory-stubs';
import { InMemoryMembershipNotificationPort } from '../../infrastructure/in-memory-stubs';
import {
  MEMBERSHIP_ACCESS_PORT,
  MEMBERSHIP_NOTIFICATION_PORT,
  saveNotificationFact,
} from '../ports';
import type { MembershipAccessPort } from '../ports';
import type { MembershipNotificationPort } from '../ports';
import { MEMBERSHIP_REPOSITORY } from '../../infrastructure/membership-repository';
import type { MembershipRepository } from '../../infrastructure/membership-repository';

/** 管理员移除成员输入（MEM-008：原因＋二次确认＋层级门控） */
export interface RemoveMemberInput {
  readonly periodId: string;
  readonly operatorId: string;
  /** 移除原因（MEM-008 必填） */
  readonly reason: string;
  /** 操作者二次确认（MEM-008 必须完成） */
  readonly secondConfirmed: boolean;
  /** 移除最后一名负责人时同一操作指定的继任者（ORG-024） */
  readonly successorOwnerIds?: readonly string[];
  /** 超级管理员紧急处置豁免（仅最后负责人僵局；权限由服务端重算校验） */
  readonly emergencyBypass?: boolean;
  /** 决定时关系快照：该社团全部部门/职位关系（级联执行范围） */
  readonly relationSnapshot: readonly MembershipRelationTarget[];
}

/** 移除前置失败（IFC-ERR-003/006/007） */
export class RemoveMemberError extends Error {
  constructor(code: 'IFC-ERR-003' | 'IFC-ERR-006' | 'IFC-ERR-007', message: string) {
    super(`${code}: ${message}`);
    this.name = 'RemoveMemberError';
  }
}

/**
 * 社团主动移除成员（SRS-SM-MEM-001 转换 5"管理员成员移除命令受理"；MEM-008）。
 *
 * - **角色服务端重算**（ORG-038）：操作者角色、目标主角色、现任负责人名单一律经
   MembershipAccessPort 按当前 Casdoor Group 回读重算，不信任入参；
 * - 层级门控：普通成员/部门负责人由负责人或人事移除；人事仅负责人可移除；
   负责人须另一名现任负责人，紧急情况超级管理员；
 * - **任何人不能通过移除入口处理自己**（本人离开走退出/辞职流程）；
 * - 必须填写原因并二次确认；通知当事人并保留完整历史；
 * - **紧急处置豁免仅限最后负责人僵局**（仍有其他负责人时不得启用）；
 * - 受理即转换 5：当前成员 → 退出处理中（原子保存决定/原因/快照/级联任务）。
 */
@Injectable()
export class RemoveMemberCommand {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY) private readonly repo: MembershipRepository,
    @Inject(MEMBERSHIP_ACCESS_PORT)
    private readonly access: MembershipAccessPort = new InMemoryMembershipAccessPort(),
    private readonly policy: MembershipPolicy,
    @Inject(MEMBERSHIP_NOTIFICATION_PORT)
    private readonly notifications: MembershipNotificationPort = new InMemoryMembershipNotificationPort(),
    private readonly stateMachine: MembershipPeriodStateMachine = new MembershipPeriodStateMachine(),
  ) {}

  async execute(input: RemoveMemberInput): Promise<MembershipPeriod> {
    const period = await this.repo.load(input.periodId);
    if (period === null) {
      throw new RemoveMemberError('IFC-ERR-006', '成员经历不存在');
    }
    if (period.status !== 'CURRENT_MEMBER') {
      throw new RemoveMemberError('IFC-ERR-006', '仅当前成员可被移除');
    }
    if (
      period.departure !== null &&
      period.departure.requestStatus === DepartureRequestStatus.PENDING_APPROVAL
    ) {
      throw new RemoveMemberError('IFC-ERR-006', '存在待审批的退出申请，先完成审批或撤回再移除');
    }
    if (
      period.departure !== null &&
      period.departure.requestStatus === DepartureRequestStatus.APPROVED &&
      period.departure.execution !== 'COMPLETED'
    ) {
      throw new RemoveMemberError('IFC-ERR-006', '已有在案的退出决定未完成级联，不能重复受理移除');
    }

    // 服务端重算（ORG-038）：不信任任何入参携带的角色/名单
    const [operatorRoles, targetPrimaryRole, currentOwners] = await Promise.all([
      this.access.operatorRolesAt(period.clubId, input.operatorId),
      this.access.subjectPrimaryRoleAt(period.clubId, period.subjectId),
      this.access.currentOwnerIds(period.clubId),
    ]);

    // 自我移除禁止（MEM-008：自己离开应走退出或辞职流程）
    this.policy.assertNotSelf(input.operatorId, period.subjectId);
    // 原因与二次确认（MEM-008）
    this.policy.assertRemovalConfirmed(input.reason, input.secondConfirmed);

    // 连续性兜底：主角色为负责人但名单遗漏时按负责人对待——宁可拒绝也不产生零负责人窗口
    const isSubjectOwner =
      targetPrimaryRole === 'CLUB_LEADER' || currentOwners.includes(period.subjectId);
    const effectiveOwners =
      isSubjectOwner && !currentOwners.includes(period.subjectId)
        ? [...currentOwners, period.subjectId]
        : [...currentOwners];

    const othersAfterRevoke = effectiveOwners.filter((id) => id !== period.subjectId);
    const lastOwnerDilemma = isSubjectOwner && othersAfterRevoke.length === 0;
    const operatorIsSuper = await this.access.isPlatformSuperAdmin(input.operatorId);
    if (input.emergencyBypass === true) {
      // 豁免双门：仅超级管理员 + 仅最后负责人僵局（F3：不得扩大触发面）
      if (!operatorIsSuper) {
        throw new RemoveMemberError('IFC-ERR-003', '紧急处置豁免仅超级管理员可用（ORG-024）');
      }
      if (!lastOwnerDilemma) {
        throw new RemoveMemberError(
          'IFC-ERR-006',
          '紧急处置豁免仅适用于最后一名负责人的移除僵局（ORG-024/MEM-008），其余场景须走常规层级',
        );
      }
    } else {
      // 常规层级门控（MEM-008）：目标主角色与操作者角色均为服务端重算值
      this.policy.assertCanRemoveTarget(
        [...operatorRoles],
        targetPrimaryRole === '' ? 'MEMBER' : targetPrimaryRole,
      );
    }

    // 最后负责人连续性（ORG-024）
    LastOwnerContinuityPolicy.assertNoZeroOwnerWindow({
      currentOwners: effectiveOwners,
      subjectId: period.subjectId,
      successors: input.successorOwnerIds ?? [],
      emergencyBypass: input.emergencyBypass === true,
    });

    const now = new Date().toISOString();
    const departure: MemberDepartureState = {
      kind: DepartureKind.REMOVAL,
      // 移除是管理员决定，受理即批准（无独立审批环节；决定历史完整保留）
      requestStatus: DepartureRequestStatus.APPROVED,
      reason: input.reason.trim(),
      requestedBy: input.operatorId,
      secondConfirmedAt: now,
      decidedBy: input.operatorId,
      decidedAt: now,
      rejectionReason: null,
      snapshot: [...input.relationSnapshot],
      execution: DepartureExecution.PENDING,
      attemptCount: 0,
      priorDecisions:
        period.departure !== null &&
        (period.departure.requestStatus === DepartureRequestStatus.REJECTED ||
          period.departure.requestStatus === DepartureRequestStatus.WITHDRAWN)
          ? [
              ...(period.departure.priorDecisions ?? []),
              {
                kind: period.departure.kind,
                requestStatus:
                  period.departure.requestStatus === DepartureRequestStatus.REJECTED
                    ? 'REJECTED'
                    : 'WITHDRAWN',
                requestedBy: period.departure.requestedBy,
                decidedBy: period.departure.decidedBy,
                decidedAt: period.departure.decidedAt,
                rejectionReason: period.departure.rejectionReason,
              },
            ]
          : [],
    };
    const updated: MembershipPeriod = {
      ...period,
      version: period.version + 1,
      status: this.stateMachine.transition('CURRENT_MEMBER', 'DEPARTURE_PROCESSING'), // 转换 5
      departure,
      history: [
        ...period.history,
        {
          at: now,
          type: 'REMOVAL_DECIDED',
          by: input.operatorId,
          note: '原因=' + input.reason.trim() + ' 快照=' + departure.snapshot.length,
        },
      ],
    };
    // 单胜者提交：与退出申请/撤回/外部对账并发时只一个成功（IFC-GEN-007），防止丢失更新
    const swapped = await this.repo.compareAndSwap(period, updated);
    if (!swapped) {
      throw new RemoveMemberError('IFC-ERR-007', '成员经历已被并发变更，移除受理失败，请重试');
    }
    await saveNotificationFact(this.notifications, {
      kind: 'MEMBER_REMOVAL_DECIDED',
      toUserIds: [period.subjectId, input.operatorId],
      clubId: period.clubId,
      dedupKey: 'MEMBER_REMOVAL_DECIDED:' + period.periodId + ':v' + period.version,
      title: '成员移除已受理',
      body: '正在级联移除该社团全部部门/职位关系与访问权限；完成后通知。',
    });
    return updated;
  }
}
