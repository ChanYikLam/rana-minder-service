/**
 * 参与社团结论状态机（JNT-005；SRS-SM-JNT-005）。
 *
 * 可编辑 →（面试作废未接受）待复核 → 邀请待处理 → 已接受锁定。
 * 结论可编辑；关联邀请待处理；邀请被接受后该社团结论立即锁定，不可再改为不录取。
 * 终态归档锁定，保留全部版本、作者、社团来源和邀请关联。
 */

export enum JointConclusionStatus {
  EDITABLE = 'EDITABLE',
  REVIEW_PENDING = 'REVIEW_PENDING',
  INVITE_PENDING = 'INVITE_PENDING',
  LOCKED_ACCEPTED = 'LOCKED_ACCEPTED',
  ARCHIVED_LOCKED = 'ARCHIVED_LOCKED',
}

export enum JointConclusionEvent {
  SEND_INVITE = 'SEND_INVITE',
  ACCEPT_INVITE = 'ACCEPT_INVITE',
  TO_REVIEW = 'TO_REVIEW',
  TIMEOUT_INVITE = 'TIMEOUT_INVITE',
  RESTORE_FROM_REVIEW = 'RESTORE_FROM_REVIEW',
  ARCHIVE = 'ARCHIVE',
}

export type JointConclusionDecision = 'ADMIT' | 'TRANSFER' | 'REJECT';

export interface JointConclusionTransition {
  readonly allowed: boolean;
  readonly nextState?: JointConclusionStatus;
}

export class JointConclusionStateMachine {
  transition(input: {
    event: JointConclusionEvent;
    currentState: JointConclusionStatus;
  }): JointConclusionTransition {
    const { event, currentState } = input;
    switch (event) {
      case JointConclusionEvent.SEND_INVITE:
        if (currentState === JointConclusionStatus.EDITABLE) {
          return { allowed: true, nextState: JointConclusionStatus.INVITE_PENDING };
        }
        return { allowed: false };
      case JointConclusionEvent.ACCEPT_INVITE:
        if (currentState === JointConclusionStatus.INVITE_PENDING) {
          return { allowed: true, nextState: JointConclusionStatus.LOCKED_ACCEPTED };
        }
        return { allowed: false };
      case JointConclusionEvent.TO_REVIEW:
        if (currentState === JointConclusionStatus.EDITABLE) {
          return { allowed: true, nextState: JointConclusionStatus.REVIEW_PENDING };
        }
        return { allowed: false };
      case JointConclusionEvent.TIMEOUT_INVITE:
        if (currentState === JointConclusionStatus.INVITE_PENDING) {
          return { allowed: true, nextState: JointConclusionStatus.REVIEW_PENDING };
        }
        return { allowed: false };
      case JointConclusionEvent.RESTORE_FROM_REVIEW:
        if (currentState === JointConclusionStatus.REVIEW_PENDING) {
          return { allowed: true, nextState: JointConclusionStatus.INVITE_PENDING };
        }
        return { allowed: false };
      case JointConclusionEvent.ARCHIVE:
        return { allowed: true, nextState: JointConclusionStatus.ARCHIVED_LOCKED };
      default:
        return { allowed: false };
    }
  }
}
