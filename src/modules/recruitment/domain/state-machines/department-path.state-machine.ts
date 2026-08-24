/**
 * 部门考察路径状态机（recruitment 域；REC-004、REC-018/019/020/039）。
 *
 * 路径状态：PENDING → UNDER_REVIEW（考察中）→ ADMITTED / REJECTED / WAITLISTED（候补）/ ENDED；
 * 部门 Group 异常 → SUSPENDED（恢复回原状态）。部门内部决定由负责人/人事记录，保留全部版本。
 *
 * SRS-SM-REC-004 语义：部门异常为「状态不变（部门路径暂停标志）」，修复后
 * 「恢复原主状态」。实现以独立 SUSPENDED 主状态＋previousStatusBeforeSuspend
 * 表达同一行为（持久化 schema 已落地）；仅未决主状态可被暂停，终态不可。
 */

export const DepartmentPathStatus = {
  PENDING: 'PENDING',
  UNDER_REVIEW: 'UNDER_REVIEW',
  ADMITTED: 'ADMITTED',
  REJECTED: 'REJECTED',
  WAITLISTED: 'WAITLISTED',
  ENDED: 'ENDED',
  SUSPENDED: 'SUSPENDED',
} as const;
export type DepartmentPathStatus = (typeof DepartmentPathStatus)[keyof typeof DepartmentPathStatus];

export const DepartmentDecision = {
  ADVANCE: 'ADVANCE',
  HOLD: 'HOLD',
  WAITLIST: 'WAITLIST',
  ADMIT: 'ADMIT',
  REJECT: 'REJECT',
  END: 'END',
} as const;
export type DepartmentDecision = (typeof DepartmentDecision)[keyof typeof DepartmentDecision];

export const DepartmentPathEvent = {
  RECORD_DECISION: 'RECORD_DECISION',
  SUSPEND: 'SUSPEND',
  RESTORE: 'RESTORE',
} as const;
export type DepartmentPathEvent = (typeof DepartmentPathEvent)[keyof typeof DepartmentPathEvent];

const DECISION_TO_STATUS: Readonly<Record<DepartmentDecision, DepartmentPathStatus>> = {
  ADVANCE: DepartmentPathStatus.UNDER_REVIEW,
  HOLD: DepartmentPathStatus.UNDER_REVIEW,
  WAITLIST: DepartmentPathStatus.WAITLISTED,
  ADMIT: DepartmentPathStatus.ADMITTED,
  REJECT: DepartmentPathStatus.REJECTED,
  END: DepartmentPathStatus.ENDED,
};

export interface DepartmentPathTransitionResult {
  readonly allowed: boolean;
  readonly nextState: DepartmentPathStatus;
}

export interface DepartmentPathStateMachine {
  transitionOnDecision(input: {
    readonly decision: DepartmentDecision;
    readonly currentState: DepartmentPathStatus;
  }): DepartmentPathTransitionResult;
  transitionOnSuspend(input: {
    readonly currentState: DepartmentPathStatus;
  }): DepartmentPathTransitionResult;
  /** SRS-SM-REC-004：部门修复或重新绑定通过 → 恢复原主状态 */
  transitionOnRestore(input: {
    readonly currentState: DepartmentPathStatus;
    /** 暂停前主状态（领域模型 previousStatusBeforeSuspend） */
    readonly previousStatus: DepartmentPathStatus;
  }): DepartmentPathTransitionResult;
}

export class DefaultDepartmentPathStateMachine implements DepartmentPathStateMachine {
  private readonly decisionAllowedFrom: ReadonlySet<DepartmentPathStatus> = new Set([
    DepartmentPathStatus.PENDING,
    DepartmentPathStatus.UNDER_REVIEW,
    DepartmentPathStatus.WAITLISTED,
  ]);

  /** 可被部门异常暂停的未决主状态（终态与已暂停状态不可） */
  private static readonly SUSPENDABLE_FROM: ReadonlySet<DepartmentPathStatus> = new Set([
    DepartmentPathStatus.PENDING,
    DepartmentPathStatus.UNDER_REVIEW,
    DepartmentPathStatus.WAITLISTED,
  ]);

  transitionOnDecision(input: {
    readonly decision: DepartmentDecision;
    readonly currentState: DepartmentPathStatus;
  }): DepartmentPathTransitionResult {
    if (!this.decisionAllowedFrom.has(input.currentState)) {
      return { allowed: false, nextState: input.currentState };
    }
    return { allowed: true, nextState: DECISION_TO_STATUS[input.decision] };
  }

  transitionOnSuspend(input: {
    readonly currentState: DepartmentPathStatus;
  }): DepartmentPathTransitionResult {
    // SRS-SM-REC-004：仅考察中/候补等未决路径可被部门异常暂停；
    // 已发布终态（ADMITTED/REJECTED/ENDED）与已暂停（SUSPENDED）不可
    if (!DefaultDepartmentPathStateMachine.SUSPENDABLE_FROM.has(input.currentState)) {
      return { allowed: false, nextState: input.currentState };
    }
    return { allowed: true, nextState: DepartmentPathStatus.SUSPENDED };
  }

  transitionOnRestore(input: {
    readonly currentState: DepartmentPathStatus;
    readonly previousStatus: DepartmentPathStatus;
  }): DepartmentPathTransitionResult {
    if (input.currentState !== DepartmentPathStatus.SUSPENDED) {
      return { allowed: false, nextState: input.currentState };
    }
    // 恢复目标必须是合法未决主状态，防止把暂停恢复成终态
    if (!DefaultDepartmentPathStateMachine.SUSPENDABLE_FROM.has(input.previousStatus)) {
      return { allowed: false, nextState: input.currentState };
    }
    return { allowed: true, nextState: input.previousStatus };
  }
}
