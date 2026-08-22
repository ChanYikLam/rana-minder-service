import { Inject, Injectable } from '@nestjs/common';
import { CorrectionStatus } from '../../domain/state-machines/correction-state-machine';
import { CORRECTION_REPOSITORY } from '../../infrastructure/correction-repository';
import type { CorrectionRepository } from '../../infrastructure/correction-repository';
import { CorrectionCommandError } from '../commands/correction-submit.command';

/** 纠错状态查询视图（真实状态；含历史） */
export interface CorrectionStatusView {
  readonly correctionId: string;
  readonly status: string;
  /** 逾期标志（仅标记，不自动处置） */
  readonly overdue: boolean;
  readonly objectiveErrorType: string;
  readonly submittedAt: string | null;
  /** 处理决定（含批准时追加的原值/新值/原因，AUD-001） */
  readonly decision: {
    readonly approved: boolean;
    readonly decidedBy: string;
    readonly decidedAt: string;
    readonly reason: string;
    readonly oldValue: string;
    readonly newValue: string;
  } | null;
  /** 完整历史（批准/驳回/撤回保留） */
  readonly history: readonly { at: string; type: string; by: string }[];
}

/**
 * 纠错状态查询（IFC-SM-028）。
 * 返回真实状态与完整历史；逾期仅标志不自动处置。
 */
@Injectable()
export class CorrectionStatusQuery {
  constructor(@Inject(CORRECTION_REPOSITORY) private readonly repo: CorrectionRepository) {}

  async getStatus(correctionId: string): Promise<CorrectionStatusView> {
    const correction = await this.repo.load(correctionId);
    if (correction === null) {
      throw new CorrectionCommandError('IFC-ERR-006', '纠错申请不存在');
    }
    return {
      correctionId: correction.correctionId,
      status: correction.status,
      overdue:
        correction.status === CorrectionStatus.OVERDUE_PENDING ||
        correction.overdueMarkedAt !== null,
      objectiveErrorType: correction.objectiveErrorType,
      submittedAt: correction.submittedAt,
      decision:
        correction.decision !== null
          ? {
              approved: correction.status === CorrectionStatus.APPROVED,
              decidedBy: correction.decision.decidedBy,
              decidedAt: correction.decision.decidedAt,
              reason: correction.decision.reason,
              oldValue: correction.decision.oldValue,
              newValue: correction.decision.newValue,
            }
          : null,
      history: correction.history.map((h) => ({ at: h.at, type: h.type, by: h.by })),
    };
  }
}
