/**
 * 面试记录状态机（recruitment 域；REC-005、REC-011/041、PRD-OPT-025）。
 *
 * 面试记录状态：待选择 → 已安排 → 进行中 → 已完成；作废（VOIDED，待重新安排唯一例外）
 * 或取消；跳轮/免试（SKIPPED，不伪造已完成记录）；暂缓（HOLD，到期只提醒不淘汰）。
 * 每人每轮一份有效记录；作废不删除原始事实，重排回已安排。
 */

export const InterviewRecordStatus = {
  PENDING_SELECTION: 'PENDING_SELECTION',
  SCHEDULED: 'SCHEDULED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  VOIDED: 'VOIDED',
  CANCELLED: 'CANCELLED',
  SKIPPED: 'SKIPPED',
  HOLD: 'HOLD',
} as const;
export type InterviewRecordStatus =
  (typeof InterviewRecordStatus)[keyof typeof InterviewRecordStatus];

export const InterviewRecordEvent = {
  SCHEDULE: 'SCHEDULE',
  START: 'START',
  COMPLETE: 'COMPLETE',
  VOID: 'VOID',
  CANCEL: 'CANCEL',
  RESCHEDULE: 'RESCHEDULE',
  SKIP: 'SKIP',
  HOLD: 'HOLD',
  RESUME: 'RESUME',
} as const;
export type InterviewRecordEvent = (typeof InterviewRecordEvent)[keyof typeof InterviewRecordEvent];

export interface InterviewTransitionResult {
  readonly allowed: boolean;
  readonly nextState: InterviewRecordStatus;
}

export interface InterviewRecordStateMachine {
  transition(input: {
    readonly event: InterviewRecordEvent;
    readonly currentState: InterviewRecordStatus;
  }): InterviewTransitionResult;
}

export class DefaultInterviewRecordStateMachine implements InterviewRecordStateMachine {
  private readonly table: Readonly<
    Partial<
      Record<InterviewRecordStatus, Partial<Record<InterviewRecordEvent, InterviewRecordStatus>>>
    >
  > = {
    PENDING_SELECTION: {
      SCHEDULE: InterviewRecordStatus.SCHEDULED,
      CANCEL: InterviewRecordStatus.CANCELLED,
      SKIP: InterviewRecordStatus.SKIPPED,
      HOLD: InterviewRecordStatus.HOLD,
    },
    SCHEDULED: {
      START: InterviewRecordStatus.IN_PROGRESS,
      VOID: InterviewRecordStatus.VOIDED,
      CANCEL: InterviewRecordStatus.CANCELLED,
    },
    IN_PROGRESS: {
      COMPLETE: InterviewRecordStatus.COMPLETED,
      VOID: InterviewRecordStatus.VOIDED,
    },
    COMPLETED: {},
    VOIDED: { RESCHEDULE: InterviewRecordStatus.SCHEDULED },
    SKIPPED: {},
    HOLD: { RESUME: InterviewRecordStatus.PENDING_SELECTION },
    CANCELLED: {},
  };

  transition(input: {
    readonly event: InterviewRecordEvent;
    readonly currentState: InterviewRecordStatus;
  }): InterviewTransitionResult {
    const next = this.table[input.currentState]?.[input.event];
    if (next === undefined) {
      return { allowed: false, nextState: input.currentState };
    }
    return { allowed: true, nextState: next };
  }
}
