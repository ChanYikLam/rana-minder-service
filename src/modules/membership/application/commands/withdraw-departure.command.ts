import { Inject, Injectable } from '@nestjs/common';

import type { MembershipPeriod } from '../../domain/models/membership-period';
import { DepartureRequestStatus } from '../../domain/models/membership-period';
import { MEMBERSHIP_REPOSITORY } from '../../infrastructure/membership-repository';
import type { MembershipRepository } from '../../infrastructure/membership-repository';

/** 撤回退出申请输入（MEM-005：待审批期间申请人可撤回） */
export interface WithdrawDepartureInput {
  readonly periodId: string;
  /** 必须为申请人本人 */
  readonly requesterId: string;
}

/** 撤回前置失败（IFC-ERR-003/006/007） */
export class WithdrawDepartureError extends Error {
  constructor(code: 'IFC-ERR-003' | 'IFC-ERR-006' | 'IFC-ERR-007', message: string) {
    super(`${code}: ${message}`);
    this.name = 'WithdrawDepartureError';
  }
}

/**
 * 撤回退出申请（MEM-005：待审批期间可撤回；撤回后不可再审批）。
 *
 * - 撤回与审批**并发只一个成功**（版本比较并交换，IFC-GEN-007）；
 * - 仅待审批状态可撤回；已批准（进入退出处理中）后不可撤回，
   后续关系变化走成员生命周期正式流程。
 */
@Injectable()
export class WithdrawDepartureCommand {
  constructor(@Inject(MEMBERSHIP_REPOSITORY) private readonly repo: MembershipRepository) {}

  async execute(input: WithdrawDepartureInput): Promise<MembershipPeriod> {
    const period = await this.repo.load(input.periodId);
    if (period === null) {
      throw new WithdrawDepartureError('IFC-ERR-006', '成员经历不存在');
    }
    if (input.requesterId !== period.subjectId) {
      throw new WithdrawDepartureError('IFC-ERR-003', '仅申请人本人可撤回退出申请');
    }
    if (
      period.departure === null ||
      period.departure.requestStatus !== DepartureRequestStatus.PENDING_APPROVAL
    ) {
      throw new WithdrawDepartureError('IFC-ERR-007', '退出申请不在待审批状态，不能撤回');
    }
    const now = new Date().toISOString();
    const updated: MembershipPeriod = {
      ...period,
      version: period.version + 1,
      departure: { ...period.departure, requestStatus: DepartureRequestStatus.WITHDRAWN },
      history: [...period.history, { at: now, type: 'DEPARTURE_WITHDRAWN', by: input.requesterId }],
    };
    const swapped = await this.repo.compareAndSwap(period, updated);
    if (!swapped) {
      // 撤回与审批/驳回并发：只一个成功（IFC-GEN-007）
      throw new WithdrawDepartureError('IFC-ERR-007', '退出申请已被并发审批处理，撤回失败');
    }
    return updated;
  }
}
