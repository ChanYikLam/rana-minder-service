/**
 * 面试记录状态机（recruitment 域；REC-005、REC-011/041、PRD-OPT-025）。
 *
 * 面试记录状态：待选择 → 已安排 → 进行中 → 已完成；
 * 出勤事件：请假/迟到/缺席（已安排可标记；迟到可开始；三者均可重排/取消，
 * SRS-SM-REC-005）；作废（VOIDED，待重新安排唯一例外）或取消；
 * 跳轮/免试（SKIPPED，不伪造已完成记录，可从待选择或已安排发起，REC-040）；
 * 暂缓（HOLD，到期只提醒不淘汰）。每人每轮一份有效记录；作废不删除原始事实。
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
  ON_LEAVE: 'ON_LEAVE',
  LATE: 'LATE',
  ABSENT: 'ABSENT',
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
  MARK_ON_LEAVE: 'MARK_ON_LEAVE',
  MARK_LATE: 'MARK_LATE',
  MARK_ABSENT: 'MARK_ABSENT',
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
      SKIP: InterviewRecordStatus.SKIPPED, // REC-040：待选择或已安排可跳轮/免试
      MARK_ON_LEAVE: InterviewRecordStatus.ON_LEAVE,
      MARK_LATE: InterviewRecordStatus.LATE,
      MARK_ABSENT: InterviewRecordStatus.ABSENT,
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
    // 出勤状态（SRS-SM-REC-005）：请假/迟到/缺席 → 重新安排 → 已安排；
    // 迟到可开始 → 进行中；三者均可取消
    ON_LEAVE: {
      RESCHEDULE: InterviewRecordStatus.SCHEDULED,
      CANCEL: InterviewRecordStatus.CANCELLED,
    },
    LATE: {
      START: InterviewRecordStatus.IN_PROGRESS,
      RESCHEDULE: InterviewRecordStatus.SCHEDULED,
      CANCEL: InterviewRecordStatus.CANCELLED,
    },
    ABSENT: {
      RESCHEDULE: InterviewRecordStatus.SCHEDULED,
      CANCEL: InterviewRecordStatus.CANCELLED,
    },
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
