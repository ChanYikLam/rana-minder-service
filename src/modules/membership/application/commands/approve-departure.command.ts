import { Inject, Injectable } from '@nestjs/common';

import type {
  MemberDepartureState,
  MembershipPeriod,
  MembershipRelationTarget,
} from '../../domain/models/membership-period';
import { DepartureExecution, DepartureRequestStatus } from '../../domain/models/membership-period';
import { LastOwnerContinuityPolicy } from '../../../organization/domain/services/last-owner-continuity.policy';
import { MembershipPolicy } from '../../domain/services/membership-policy';
import {
  InMemoryMembershipAccessPort,
  InMemoryMembershipNotificationPort,
} from '../../infrastructure/in-memory-stubs';
import { MEMBERSHIP_ACCESS_PORT, MEMBERSHIP_NOTIFICATION_PORT } from '../ports';
import type { MembershipAccessPort } from '../ports';
import type { MembershipNotificationPort } from '../ports';
import { MEMBERSHIP_REPOSITORY } from '../../infrastructure/membership-repository';
import type { MembershipRepository } from '../../infrastructure/membership-repository';

/** 审批退出输入（MEM-005：负责人/人事审批；批准即转换 5） */
export interface ApproveDepartureInput {
  readonly periodId: string;
  readonly approverId: string;
  readonly action: 'approve' | 'reject';
  /** 驳回必填原因（MEM-005） */
  readonly rejectionReason?: string;
  /** 批准最后一名负责人退出时，同一操作指定的继任者（ORG-024 交接锚点） */
  readonly successorOwnerIds?: readonly string[];
  /** 超级管理员紧急处置豁免（仅最后负责人僵局；权限由服务端重算校验） */
  readonly emergencyBypass?: boolean;
  /** 决定时关系快照：该社团全部部门/职位关系（级联执行范围；转换 5 原子保存） */
  readonly relationSnapshot: readonly MembershipRelationTarget[];
}

/** 审批前置失败（IFC-ERR-003/006/007） */
export class ApproveDepartureError extends Error {
  constructor(code: 'IFC-ERR-003' | 'IFC-ERR-006' | 'IFC-ERR-007', message: string) {
    super(`${code}: ${message}`);
    this.name = 'ApproveDepartureError';
  }
}

/**
 * 审批主动退出（SRS-SM-MEM-001 转换 5 的"提交并批准"收口；MEM-002/005）。
 *
 * - **角色与负责人名单服务端重算**（ORG-038）：审批人角色、被审批人主角色、
   现任负责人一律经 MembershipAccessPort 按当前 Casdoor Group 回读，不信任入参；
 * - 任一社团负责人或人事管理员可审批；**部门负责人无权**；不能自审；
 * - 驳回必须填写原因；批准/驳回均通知成员（通知事实同事务落库）；
 * - **批准 → 退出处理中**：原子保存决定、原因、关系快照与级联移除任务意图；
   回读前原关系通常保持有效（ORG-027）；
 * - **最后一名负责人必须先交接或由超管紧急处置**（ORG-024、MEM-002）：复用组织模块
   连续性策略；紧急处置豁免双门校验——仅超级管理员且仅最后负责人僵局可用。
 */
@Injectable()
export class ApproveDepartureCommand {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY) private readonly repo: MembershipRepository,
    @Inject(MEMBERSHIP_ACCESS_PORT)
    private readonly access: MembershipAccessPort = new InMemoryMembershipAccessPort(),
    private readonly policy: MembershipPolicy,
    @Inject(MEMBERSHIP_NOTIFICATION_PORT)
    private readonly notifications: MembershipNotificationPort = new InMemoryMembershipNotificationPort(),
  ) {}

  async execute(input: ApproveDepartureInput): Promise<MembershipPeriod> {
    const period = await this.repo.load(input.periodId);
    if (period === null) {
      throw new ApproveDepartureError('IFC-ERR-006', '成员经历不存在');
    }
    if (period.status !== 'CURRENT_MEMBER' || period.departure === null) {
      throw new ApproveDepartureError('IFC-ERR-007', '成员不在待审批状态');
    }
    if (period.departure.requestStatus !== DepartureRequestStatus.PENDING_APPROVAL) {
      throw new ApproveDepartureError(
        'IFC-ERR-007',
        `退出申请状态为 ${period.departure.requestStatus}，不能审批`,
      );
    }

    // 服务端重算（ORG-038）：审批人角色、目标主角色、现任负责人按当前关系回读
    const [approverRoles, targetPrimaryRole, currentOwners] = await Promise.all([
      this.access.operatorRolesAt(period.clubId, input.approverId),
      this.access.subjectPrimaryRoleAt(period.clubId, period.subjectId),
      this.access.currentOwnerIds(period.clubId),
    ]);

    // 连续性兜底：主角色为负责人但名单遗漏时按负责人对待——宁可拒绝也不产生零负责人窗口
    const isSubjectOwner =
      targetPrimaryRole === 'CLUB_LEADER' || currentOwners.includes(period.subjectId);
    const effectiveOwners =
      isSubjectOwner && !currentOwners.includes(period.subjectId)
        ? [...currentOwners, period.subjectId]
        : [...currentOwners];
    const othersAfterRevoke = effectiveOwners.filter((id) => id !== period.subjectId);
    const lastOwnerDilemma = isSubjectOwner && othersAfterRevoke.length === 0;

    // 权限与自审门控（MEM-005）；超管紧急处置豁免双门（F3：仅超管＋仅僵局）
    this.policy.assertNotSelf(input.approverId, period.subjectId);
    if (input.emergencyBypass === true) {
      const operatorIsSuper = await this.access.isPlatformSuperAdmin(input.approverId);
      if (!operatorIsSuper) {
        throw new ApproveDepartureError('IFC-ERR-003', '紧急处置豁免仅超级管理员可用（ORG-024）');
      }
      if (!lastOwnerDilemma) {
        throw new ApproveDepartureError(
          'IFC-ERR-006',
          '紧急处置豁免仅适用于最后一名负责人的退出僵局（ORG-024/MEM-002），其余场景须由负责人/人事常规审批',
        );
      }
    } else {
      this.policy.assertCanApproveDeparture([...approverRoles]);
    }

    const now = new Date().toISOString();

    if (input.action === 'reject') {
      this.policy.assertRejectionReason(input.rejectionReason);
      const rejected: MembershipPeriod = {
        ...period,
        version: period.version + 1,
        departure: {
          ...period.departure,
          requestStatus: DepartureRequestStatus.REJECTED,
          decidedBy: input.approverId,
          decidedAt: now,
          rejectionReason: input.rejectionReason?.trim() ?? null,
        },
        history: [...period.history, { at: now, type: 'DEPARTURE_REJECTED', by: input.approverId }],
      };
      const swappedOk = await this.repo.compareAndSwap(period, rejected);
      if (!swappedOk) {
        throw new ApproveDepartureError(
          'IFC-ERR-007',
          '退出申请已被并发处理（撤回/审批竞争），只一个成功',
        );
      }
      await this.notifications.save({
        kind: 'MEMBER_DEPARTURE_REJECTED',
        toUserIds: [period.subjectId],
        clubId: period.clubId,
        dedupKey: 'MEMBER_DEPARTURE_REJECTED:' + period.periodId,
        title: '退出申请已驳回',
        body: '原因：' + (input.rejectionReason?.trim() ?? ''),
      });
      return rejected;
    }

    // 最后负责人连续性（ORG-024；复用组织模块策略，语义一处收敛）
    LastOwnerContinuityPolicy.assertNoZeroOwnerWindow({
      currentOwners: effectiveOwners,
      subjectId: period.subjectId,
      successors: input.successorOwnerIds ?? [],
      emergencyBypass: input.emergencyBypass === true,
    });

    const departure: MemberDepartureState = {
      ...period.departure,
      requestStatus: DepartureRequestStatus.APPROVED,
      decidedBy: input.approverId,
      decidedAt: now,
      snapshot: [...input.relationSnapshot],
      execution: DepartureExecution.PENDING,
    };
    const approved: MembershipPeriod = {
      ...period,
      version: period.version + 1,
      status: 'DEPARTURE_PROCESSING', // 转换 5：当前成员 → 退出处理中
      departure,
      history: [
        ...period.history,
        {
          at: now,
          type: 'DEPARTURE_APPROVED',
          by: input.approverId,
          note: 'snapshot=' + departure.snapshot.length,
        },
      ],
    };
    const swapped = await this.repo.compareAndSwap(period, approved);
    if (!swapped) {
      throw new ApproveDepartureError(
        'IFC-ERR-007',
        '退出申请已被并发处理（撤回/审批竞争），只一个成功',
      );
    }
    await this.notifications.save({
      kind: 'MEMBER_DEPARTURE_APPROVED',
      toUserIds: [period.subjectId, input.approverId],
      clubId: period.clubId,
      dedupKey: 'MEMBER_DEPARTURE_APPROVED:' + period.periodId,
      title: '退出申请已批准',
      body: '正在处理该社团全部部门/职位关系与访问权限的移除。',
    });
    return approved;
  }
}
