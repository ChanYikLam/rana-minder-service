import { Inject, Injectable } from '@nestjs/common';

import type {
  DepartureDecisionRecord,
  MemberDepartureState,
  MembershipPeriod,
} from '../../domain/models/membership-period';
import {
  DepartureExecution,
  DepartureKind,
  DepartureRequestStatus,
} from '../../domain/models/membership-period';
import { MembershipPolicy } from '../../domain/services/membership-policy';
import { InMemoryMembershipNotificationPort } from '../../infrastructure/in-memory-stubs';
import { MEMBERSHIP_NOTIFICATION_PORT } from '../ports';
import type { MembershipNotificationPort } from '../ports';
import { MEMBERSHIP_REPOSITORY } from '../../infrastructure/membership-repository';
import type { MembershipRepository } from '../../infrastructure/membership-repository';

/** 提交主动退出输入（MEM-002：本人发起＋二次确认；进入待审批） */
export interface RequestDepartureInput {
  readonly periodId: string;
  /** 必须为成员本人 */
  readonly requesterId: string;
  /** 退出原因（可选） */
  readonly reason?: string;
  /** 本人二次确认（MEM-002 必须完成） */
  readonly secondConfirmed: boolean;
}

/** 退出申请前置失败（IFC-ERR-003/006/007） */
export class RequestDepartureError extends Error {
  constructor(code: 'IFC-ERR-003' | 'IFC-ERR-006' | 'IFC-ERR-007', message: string) {
    super(`${code}: ${message}`);
    this.name = 'RequestDepartureError';
  }
}

/**
 * 成员提交主动退出申请（MEM-002、MEM-005 前置）。
 *
 * - 仅当前成员本人可发起，且必须完成**本人二次确认**后进入待审批；
 * - 待审批期间成员仍是当前成员（原关系与权限保持，ORG-027）；
 * - 批准才进入退出处理中（SRS-SM-MEM-001 转换 5 的"提交并批准"合并语义）；
 * - 已有待审批申请时拒绝重复提交；**在案决定未收口**（已批准但级联未完成，
   含失败恢复态）时不得新建申请覆盖工作态——须先人工重试完成级联；
 * - 前次被驳回/撤回的决定**结构化归档**到 priorDecisions，不随新申请丢失；
 * - 单胜者提交：与撤回/审批/移除并发只一个成功（IFC-GEN-007）。
 */
@Injectable()
export class RequestDepartureCommand {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY) private readonly repo: MembershipRepository,
    private readonly policy: MembershipPolicy,
    @Inject(MEMBERSHIP_NOTIFICATION_PORT)
    private readonly notifications: MembershipNotificationPort = new InMemoryMembershipNotificationPort(),
  ) {}

  async execute(input: RequestDepartureInput): Promise<MembershipPeriod> {
    const period = await this.repo.load(input.periodId);
    if (period === null) {
      throw new RequestDepartureError('IFC-ERR-006', '成员经历不存在');
    }
    if (input.requesterId !== period.subjectId) {
      throw new RequestDepartureError('IFC-ERR-003', '仅成员本人可发起退出申请');
    }
    if (period.status !== 'CURRENT_MEMBER') {
      throw new RequestDepartureError('IFC-ERR-006', '仅当前成员可提交退出申请');
    }
    const existing = period.departure;
    if (existing !== null) {
      if (existing.requestStatus === DepartureRequestStatus.PENDING_APPROVAL) {
        throw new RequestDepartureError('IFC-ERR-006', '已有待审批的退出申请，不能重复提交');
      }
      if (
        existing.requestStatus === DepartureRequestStatus.APPROVED &&
        existing.execution !== 'COMPLETED'
      ) {
        // 在案决定未收口（含 FAILED_RESTORED）：不得覆盖工作态，走人工重试完成级联
        throw new RequestDepartureError(
          'IFC-ERR-006',
          '已有在案的退出决定未完成级联，请先由负责人/人事人工重试完成后再发起新申请',
        );
      }
    }
    this.policy.assertSecondConfirmed(input.secondConfirmed);

    const now = new Date().toISOString();
    // 前次被驳回/撤回决定归档（决定与审批历史不可变；结构化保留）
    const priorDecisions: DepartureDecisionRecord[] = [];
    if (
      existing !== null &&
      (existing.requestStatus === DepartureRequestStatus.REJECTED ||
        existing.requestStatus === DepartureRequestStatus.WITHDRAWN)
    ) {
      priorDecisions.push({
        kind: existing.kind,
        requestStatus:
          existing.requestStatus === DepartureRequestStatus.REJECTED ? 'REJECTED' : 'WITHDRAWN',
        requestedBy: existing.requestedBy,
        decidedBy: existing.decidedBy,
        decidedAt: existing.decidedAt,
        rejectionReason: existing.rejectionReason,
      });
    }
    const departure: MemberDepartureState = {
      kind: DepartureKind.VOLUNTARY,
      requestStatus: DepartureRequestStatus.PENDING_APPROVAL,
      reason: input.reason?.trim() ? input.reason.trim() : null,
      requestedBy: input.requesterId,
      secondConfirmedAt: now,
      decidedBy: null,
      decidedAt: null,
      rejectionReason: null,
      snapshot: [], // 快照在批准时按当时关系落笔（转换 5 原子保存）
      execution: DepartureExecution.PENDING,
      attemptCount: 0,
      priorDecisions,
    };
    const updated: MembershipPeriod = {
      ...period,
      version: period.version + 1,
      departure,
      history: [...period.history, { at: now, type: 'DEPARTURE_REQUESTED', by: input.requesterId }],
    };
    // 单胜者提交：与撤回/审批/移除并发时只一个成功（IFC-GEN-007），防止丢失更新
    const swapped = await this.repo.compareAndSwap(period, updated);
    if (!swapped) {
      throw new RequestDepartureError(
        'IFC-ERR-007',
        '成员经历已被并发变更，提交退出申请失败，请重试',
      );
    }
    await this.notifications.save({
      kind: 'MEMBER_DEPARTURE_REQUESTED',
      toUserIds: [input.requesterId],
      clubId: period.clubId,
      dedupKey: 'MEMBER_DEPARTURE_REQUESTED:' + period.periodId + ':' + now,
      title: '退出申请已提交',
      body: '申请已进入待审批；审批完成前成员身份与权限保持不变。',
    });
    return updated;
  }
}
