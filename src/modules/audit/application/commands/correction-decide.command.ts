import { Inject, Injectable } from '@nestjs/common';
import {
  CorrectionStateMachine,
  CorrectionStatus,
} from '../../domain/state-machines/correction-state-machine';
import type { Correction, CorrectionDecision } from '../../domain/models/correction';
import { CorrectionPolicy } from '../../domain/services/correction-policy';
import { CORRECTION_REPOSITORY } from '../../infrastructure/correction-repository';
import type { CorrectionRepository } from '../../infrastructure/correction-repository';

/** 处理人（批准/驳回）输入（SRS-SM-AUD-001：待处理/逾期待处理→已批准/已驳回） */
export interface DecideCorrectionInput {
  readonly correctionId: string;
  readonly decider: {
    readonly principalId: string;
    readonly roles: readonly string[];
    /** 当前社团（本社团处理） */
    readonly clubId?: string;
  };
  /** approve=true 批准；false 驳回 */
  readonly approve: boolean;
  /** 驳回必填原因；批准为变更原因 */
  readonly reason: string;
  /** 批准时的原值/新值（追加；原记录保留） */
  readonly oldValue?: string;
  readonly newValue?: string;
}

/** 前置失败 */
export class DecideCorrectionError extends Error {
  constructor(
    code: 'IFC-ERR-003' | 'IFC-ERR-005' | 'IFC-ERR-006' | 'IFC-ERR-007',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'DecideCorrectionError';
  }
}

/**
 * 处理人决定（SRS-SM-AUD-001：批准/驳回）。
 *
 * - 处理人审批须**排除原作者自批**（作者回避）；
 * - 处理角色：本社团负责人/人事；联合边界（他社记录拒绝）；部门负责人不能
 *   处理活动结束后正式纠错；
 * - **驳回必填原因**（IFC-ERR-005）；
 * - 批准**只追加**原值/新值/原因/证据/处理人/时间，原记录保留；需改变当前
 *   关系时另走正式关系命令（不提供按历史一键重放）；
 * - 与驳回/原提交人撤回按申请版本比较并交换（只一个成功）；重复决定幂等。
 */
@Injectable()
export class DecideCorrectionCommand {
  constructor(
    @Inject(CORRECTION_REPOSITORY) private readonly repo: CorrectionRepository,
    private readonly policy: CorrectionPolicy,
    private readonly stateMachine: CorrectionStateMachine = new CorrectionStateMachine(),
  ) {}

  async execute(input: DecideCorrectionInput): Promise<Correction> {
    const correction = await this.repo.load(input.correctionId);
    if (correction === null) {
      throw new DecideCorrectionError('IFC-ERR-006', '纠错申请不存在');
    }
    // 处理资格（作者回避 + 处理角色 + 联合边界）
    this.policy.assertCanDecide(
      {
        principalId: input.decider.principalId,
        roles: input.decider.roles,
        clubId: input.decider.clubId,
      },
      {
        objectType: correction.targetRecord.objectType,
        ownerClubId: correction.targetRecord.ownerClubId,
      },
    );
    this.policy.assertNotSelfDecision(input.decider.principalId, correction.authorId);
    // 决定必填原因（驳回必填；批准为变更原因）
    this.policy.assertReason(input.reason);
    // 幂等/终态：相同决定 → 返回原结果；不同决定 → 终态不可覆盖（AUD-002）
    if (
      correction.status === CorrectionStatus.APPROVED ||
      correction.status === CorrectionStatus.REJECTED
    ) {
      const sameDecision = (correction.status === CorrectionStatus.APPROVED) === input.approve;
      if (sameDecision) {
        return correction;
      }
      throw new DecideCorrectionError('IFC-ERR-007', '终态不可覆盖，新证据需新申请');
    }
    if (
      correction.status !== CorrectionStatus.PENDING &&
      correction.status !== CorrectionStatus.OVERDUE_PENDING
    ) {
      throw new DecideCorrectionError('IFC-ERR-007', '仅待处理/逾期待处理可决定');
    }

    const now = new Date().toISOString();
    const decision: CorrectionDecision = {
      decidedBy: input.decider.principalId,
      decidedAt: now,
      reason: input.reason,
      oldValue: input.oldValue ?? '',
      newValue: input.newValue ?? '',
    };
    const decided: Correction = {
      ...correction,
      status: this.stateMachine.transition(
        correction.status,
        input.approve ? CorrectionStatus.APPROVED : CorrectionStatus.REJECTED,
      ),
      version: correction.version + 1,
      decision,
      history: [
        ...correction.history,
        {
          at: now,
          type: input.approve ? 'APPROVED' : 'REJECTED',
          by: input.decider.principalId,
        },
      ],
    };
    if (!(await this.repo.compareAndSwap(correction, decided))) {
      throw new DecideCorrectionError('IFC-ERR-007', '纠错申请已被并发变更，决定失败');
    }
    return decided;
  }
}

/** 撤回输入（SRS-SM-AUD-001：待处理/逾期待处理→已撤回；仅原提交人） */
export interface WithdrawCorrectionInput {
  readonly correctionId: string;
  readonly applicantId: string;
}

/**
 * 原提交人撤回（SRS-SM-AUD-001）。
 *
 * - **仅原提交人本人**（处理角色代撤拒绝）；
 * - 待处理/逾期待处理可撤回（处理人已查看/领取/调查及逾期均不阻止撤回）；
 * - 完整保留正式申请、证据、处理过程和逾期历史；原业务记录不变；
 * - 与批准/驳回按同一申请版本比较并交换（只一个成功）。
 */
@Injectable()
export class WithdrawCorrectionCommand {
  constructor(
    @Inject(CORRECTION_REPOSITORY) private readonly repo: CorrectionRepository,
    private readonly stateMachine: CorrectionStateMachine = new CorrectionStateMachine(),
  ) {}

  async execute(input: WithdrawCorrectionInput): Promise<Correction> {
    const correction = await this.repo.load(input.correctionId);
    if (correction === null) {
      throw new DecideCorrectionError('IFC-ERR-006', '纠错申请不存在');
    }
    if (correction.applicantId !== input.applicantId) {
      throw new DecideCorrectionError('IFC-ERR-003', '仅原提交人可撤回纠错申请');
    }
    if (correction.status === CorrectionStatus.WITHDRAWN) {
      return correction; // 幂等
    }
    if (
      correction.status !== CorrectionStatus.PENDING &&
      correction.status !== CorrectionStatus.OVERDUE_PENDING
    ) {
      throw new DecideCorrectionError('IFC-ERR-007', '仅待处理/逾期待处理可撤回');
    }
    const now = new Date().toISOString();
    const withdrawn: Correction = {
      ...correction,
      status: this.stateMachine.transition(correction.status, CorrectionStatus.WITHDRAWN),
      version: correction.version + 1,
      history: [...correction.history, { at: now, type: 'WITHDRAWN', by: input.applicantId }],
    };
    if (!(await this.repo.compareAndSwap(correction, withdrawn))) {
      throw new DecideCorrectionError('IFC-ERR-007', '纠错申请已被并发变更，撤回失败');
    }
    return withdrawn;
  }
}

/** 逾期标记输入（系统截止任务；SRS-SM-AUD-001：待处理→逾期待处理） */
export interface MarkOverdueInput {
  readonly correctionId: string;
}

/**
 * 逾期标记（系统截止任务）。
 *
 * - **逾期只标记并提醒，不自动批准/驳回/修改业务记录**（AUD-010、PRD-OPT-044）；
 * - 截止任务幂等；与处理决定竞争只一个成功。
 */
@Injectable()
export class MarkOverdueCommand {
  constructor(
    @Inject(CORRECTION_REPOSITORY) private readonly repo: CorrectionRepository,
    private readonly stateMachine: CorrectionStateMachine = new CorrectionStateMachine(),
  ) {}

  async execute(input: MarkOverdueInput): Promise<Correction | null> {
    const correction = await this.repo.load(input.correctionId);
    if (correction === null) {
      return null;
    }
    if (correction.status === CorrectionStatus.OVERDUE_PENDING) {
      return correction; // 幂等
    }
    if (correction.status !== CorrectionStatus.PENDING) {
      return correction; // 已决定/已撤回：不转换
    }
    const now = new Date().toISOString();
    const overdue: Correction = {
      ...correction,
      status: this.stateMachine.transition(correction.status, CorrectionStatus.OVERDUE_PENDING),
      version: correction.version + 1,
      overdueMarkedAt: now,
      history: [...correction.history, { at: now, type: 'MARKED_OVERDUE', by: 'system' }],
    };
    if (!(await this.repo.compareAndSwap(correction, overdue))) {
      return correction; // 与决定竞争失败
    }
    return overdue;
  }
}
