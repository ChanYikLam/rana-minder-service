/**
 * 招新活动状态机（recruitment 域；REC-001、SRS-SM-REC-001）。
 *
 * 生命周期：DRAFT → OPEN → COMPLETED / CANCELLED。
 * 暂停（paused）是与主阶段正交的标志：冻结全部业务操作与截止，恢复按暂停
 * 时长顺延（REC-001/003、ORG-028）。COMPLETED/CANCELLED 为终态，长期只读。
 */

export const RecruitmentActivityStatus = {
  DRAFT: 'DRAFT',
  OPEN: 'OPEN',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;
export type RecruitmentActivityStatus =
  (typeof RecruitmentActivityStatus)[keyof typeof RecruitmentActivityStatus];

export const RecruitmentActivityEvent = {
  PUBLISH: 'PUBLISH',
  COMPLETE: 'COMPLETE',
  CANCEL: 'CANCEL',
} as const;
export type RecruitmentActivityEvent =
  (typeof RecruitmentActivityEvent)[keyof typeof RecruitmentActivityEvent];

export interface StateTransitionResult {
  readonly allowed: boolean;
  readonly nextState: RecruitmentActivityStatus;
}

export interface RecruitmentActivityStateMachine {
  transition(input: {
    readonly event: RecruitmentActivityEvent;
    readonly currentState: RecruitmentActivityStatus;
  }): StateTransitionResult;
}

export class DefaultRecruitmentActivityStateMachine implements RecruitmentActivityStateMachine {
  private readonly table: Readonly<
    Partial<
      Record<
        RecruitmentActivityStatus,
        Partial<Record<RecruitmentActivityEvent, RecruitmentActivityStatus>>
      >
    >
  > = {
    DRAFT: { PUBLISH: RecruitmentActivityStatus.OPEN },
    OPEN: {
      COMPLETE: RecruitmentActivityStatus.COMPLETED,
      CANCEL: RecruitmentActivityStatus.CANCELLED,
    },
  };

  transition(input: {
    readonly event: RecruitmentActivityEvent;
    readonly currentState: RecruitmentActivityStatus;
  }): StateTransitionResult {
    const next = this.table[input.currentState]?.[input.event];
    if (next === undefined) {
      return { allowed: false, nextState: input.currentState };
    }
    return { allowed: true, nextState: next };
  }
}
