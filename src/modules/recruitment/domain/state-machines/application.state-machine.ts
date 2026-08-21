/**
 * 招新申请状态机（recruitment 域；REC-003、SRS-SM-REC-003）。
 *
 * 申请生命周期：DRAFT → SUBMITTED；
 * 撤回 WITHDRAWN（可重提回 SUBMITTED）；接受录取前可 EXITED（主动退出）；
 * 身份异常 IDENTITY_EXCEPTION（恢复回 SUBMITTED）；最终未录取 FINAL_REJECTED。
 * 补充窗口为标记（不切换主状态，FORM-011）。
 */

export const ApplicationStatus = {
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  WITHDRAWN: 'WITHDRAWN',
  EXITED: 'EXITED',
  IDENTITY_EXCEPTION: 'IDENTITY_EXCEPTION',
  FINAL_REJECTED: 'FINAL_REJECTED',
  ADMITTED: 'ADMITTED',
  ACCEPTED: 'ACCEPTED',
} as const;
export type ApplicationStatus = (typeof ApplicationStatus)[keyof typeof ApplicationStatus];

export const ApplicationEvent = {
  SUBMIT: 'SUBMIT',
  WITHDRAW: 'WITHDRAW',
  RESUBMIT: 'RESUBMIT',
  EXIT: 'EXIT',
  MARK_IDENTITY_EXCEPTION: 'MARK_IDENTITY_EXCEPTION',
  RESTORE_IDENTITY: 'RESTORE_IDENTITY',
  FINAL_REJECT: 'FINAL_REJECT',
  SEND_INVITATION: 'SEND_INVITATION',
  ACCEPT_INVITATION: 'ACCEPT_INVITATION',
} as const;
export type ApplicationEvent = (typeof ApplicationEvent)[keyof typeof ApplicationEvent];

export interface ApplicationTransitionResult {
  readonly allowed: boolean;
  readonly nextState: ApplicationStatus;
}

export interface ApplicationStateMachine {
  transition(input: {
    readonly event: ApplicationEvent;
    readonly currentState: ApplicationStatus;
  }): ApplicationTransitionResult;
}

export class DefaultApplicationStateMachine implements ApplicationStateMachine {
  private readonly table: Readonly<
    Partial<Record<ApplicationStatus, Partial<Record<ApplicationEvent, ApplicationStatus>>>>
  > = {
    DRAFT: { SUBMIT: ApplicationStatus.SUBMITTED },
    SUBMITTED: {
      WITHDRAW: ApplicationStatus.WITHDRAWN,
      EXIT: ApplicationStatus.EXITED,
      MARK_IDENTITY_EXCEPTION: ApplicationStatus.IDENTITY_EXCEPTION,
      FINAL_REJECT: ApplicationStatus.FINAL_REJECTED,
      SEND_INVITATION: ApplicationStatus.ADMITTED,
    },
    WITHDRAWN: {
      RESUBMIT: ApplicationStatus.SUBMITTED,
      EXIT: ApplicationStatus.EXITED,
    },
    IDENTITY_EXCEPTION: { RESTORE_IDENTITY: ApplicationStatus.SUBMITTED },
    ADMITTED: {
      ACCEPT_INVITATION: ApplicationStatus.ACCEPTED,
      EXIT: ApplicationStatus.EXITED,
      FINAL_REJECT: ApplicationStatus.FINAL_REJECTED,
    },
    ACCEPTED: {},
  };

  transition(input: {
    readonly event: ApplicationEvent;
    readonly currentState: ApplicationStatus;
  }): ApplicationTransitionResult {
    const next = this.table[input.currentState]?.[input.event];
    if (next === undefined) {
      return { allowed: false, nextState: input.currentState };
    }
    return { allowed: true, nextState: next };
  }
}
