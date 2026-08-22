/**
 * 纠错状态机（SRS-SM-AUD-001，IFC-SM-028）。
 *
 * 状态：新建 → 草稿 → 待处理 →（已批准 / 已驳回）；待处理 → 逾期待处理
 * （系统截止任务仅置逾期标志，不自动决定）；待处理/逾期待处理 → 已撤回
 * （仅原提交人；与批准/驳回按同一申请版本竞争）。
 *
 * 核心不变量（AUD-001/002/010）：
 * - 终态（已批准/已驳回/已撤回）**不可覆盖**（新证据需新申请）；
 * - 逾期**不自动批准/驳回/修改业务记录**，只标记并提醒；
 * - 批准/驳回/撤回均保留完整历史（纠错只追加）。
 */
export const CorrectionStatus = {
  NEW: 'NEW',
  DRAFT: 'DRAFT',
  PENDING: 'PENDING',
  /** 逾期待处理（仅标志；不自动处置） */
  OVERDUE_PENDING: 'OVERDUE_PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  WITHDRAWN: 'WITHDRAWN',
} as const;

export type CorrectionStatus = (typeof CorrectionStatus)[keyof typeof CorrectionStatus];

/** 终态（不可覆盖；AUD-002） */
export const CORRECTION_TERMINAL: readonly CorrectionStatus[] = [
  CorrectionStatus.APPROVED,
  CorrectionStatus.REJECTED,
  CorrectionStatus.WITHDRAWN,
];

/** 转换非法异常（IFC-ERR-007 状态冲突） */
export class IllegalCorrectionTransitionError extends Error {
  constructor(from: CorrectionStatus, to: CorrectionStatus) {
    super(`IFC-ERR-007: 非法纠错状态转换 ${from} -> ${to}`);
    this.name = 'IllegalCorrectionTransitionError';
  }
}

/** 转换规则（SRS-SM-AUD-001 10.2 明细） */
const TRANSITIONS: Readonly<Record<CorrectionStatus, readonly CorrectionStatus[]>> = {
  [CorrectionStatus.NEW]: [CorrectionStatus.DRAFT],
  [CorrectionStatus.DRAFT]: [CorrectionStatus.PENDING],
  [CorrectionStatus.PENDING]: [
    CorrectionStatus.APPROVED,
    CorrectionStatus.REJECTED,
    CorrectionStatus.OVERDUE_PENDING,
    CorrectionStatus.WITHDRAWN,
  ],
  [CorrectionStatus.OVERDUE_PENDING]: [
    CorrectionStatus.APPROVED,
    CorrectionStatus.REJECTED,
    CorrectionStatus.WITHDRAWN,
  ],
  // 终态不可覆盖
  [CorrectionStatus.APPROVED]: [],
  [CorrectionStatus.REJECTED]: [],
  [CorrectionStatus.WITHDRAWN]: [],
};

/** 纠错状态机（纯规则；SRS-SM-AUD-001） */
export class CorrectionStateMachine {
  canTransition(from: CorrectionStatus, to: CorrectionStatus): boolean {
    return TRANSITIONS[from].includes(to);
  }

  /** 执行转换；非法转换抛 IllegalCorrectionTransitionError */
  transition(from: CorrectionStatus, to: CorrectionStatus): CorrectionStatus {
    if (!this.canTransition(from, to)) {
      throw new IllegalCorrectionTransitionError(from, to);
    }
    return to;
  }

  /** 终态不可覆盖（AUD-002） */
  isTerminal(status: CorrectionStatus): boolean {
    return CORRECTION_TERMINAL.includes(status);
  }
}
