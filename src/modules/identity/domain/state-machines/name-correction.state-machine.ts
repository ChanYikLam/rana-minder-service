/**
 * 姓名更正申请状态机（IDN-016；SRS-SM-IDN-003 只读权威字段例外路径）。
 *
 * 转换：
 * - SUBMITTED → APPROVED：超级管理员批准（高风险命令：最近 10 分钟重认证 +
 *   二次确认，CAS-REC-003）；
 * - SUBMITTED → REJECTED：超级管理员驳回；
 * - 终态（APPROVED/REJECTED）不再接受任何转换（审批只一次，重复裁决拒绝）。
 *
 * 批准后姓名以新值进入 Casdoor 同步（写后定向读回收口，CAS-REC-001）；
 * 本地审计保留旧姓名（IDN-016）。
 */

export const NameCorrectionState = {
  SUBMITTED: 'SUBMITTED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;
export type NameCorrectionState = (typeof NameCorrectionState)[keyof typeof NameCorrectionState];

export const NameCorrectionEvent = {
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
} as const;
export type NameCorrectionEvent = (typeof NameCorrectionEvent)[keyof typeof NameCorrectionEvent];

export interface NameCorrectionTransitionResult {
  readonly allowed: boolean;
  readonly nextState: NameCorrectionState;
  readonly reason: string | null;
}

export interface NameCorrectionTransitionInput {
  readonly event: NameCorrectionEvent;
  readonly currentState: NameCorrectionState;
}

export interface NameCorrectionStateMachine {
  transition(input: NameCorrectionTransitionInput): NameCorrectionTransitionResult;
}

export class DefaultNameCorrectionStateMachine implements NameCorrectionStateMachine {
  transition(input: NameCorrectionTransitionInput): NameCorrectionTransitionResult {
    if (input.currentState === NameCorrectionState.SUBMITTED) {
      if (input.event === NameCorrectionEvent.APPROVE) {
        return { allowed: true, nextState: NameCorrectionState.APPROVED, reason: null };
      }
      if (input.event === NameCorrectionEvent.REJECT) {
        return { allowed: true, nextState: NameCorrectionState.REJECTED, reason: null };
      }
    }
    if (input.currentState !== NameCorrectionState.SUBMITTED) {
      return {
        allowed: false,
        nextState: input.currentState,
        reason: '终态申请不接受再次裁决（审批只一次）',
      };
    }
    return { allowed: false, nextState: input.currentState, reason: '未知裁决事件' };
  }
}
