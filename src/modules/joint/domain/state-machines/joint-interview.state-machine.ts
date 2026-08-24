/**
 * 联合单次面试记录状态机（JNT-004；SRS-SM-JNT-004）。
 *
 * 待选择 → 已安排 → 进行中 → 已完成 / 已作废（待重排）。
 * 作废是无效面试重新安排的唯一例外，不删除原始事实；活动结束前均可修改评价。
 */

export enum JointInterviewStatus {
  PENDING_CHOICE = 'PENDING_CHOICE',
  SCHEDULED = 'SCHEDULED',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  VOIDED = 'VOIDED',
}

export enum JointInterviewEvent {
  SCHEDULE = 'SCHEDULE',
  START = 'START',
  COMPLETE = 'COMPLETE',
  VOID = 'VOID',
  RESCHEDULE = 'RESCHEDULE',
}

export interface JointInterviewTransition {
  readonly allowed: boolean;
  readonly nextState?: JointInterviewStatus;
}

export class JointInterviewStateMachine {
  transition(input: {
    event: JointInterviewEvent;
    currentState: JointInterviewStatus;
  }): JointInterviewTransition {
    const { event, currentState } = input;
    switch (event) {
      case JointInterviewEvent.SCHEDULE:
        if (currentState === JointInterviewStatus.PENDING_CHOICE) {
          return { allowed: true, nextState: JointInterviewStatus.SCHEDULED };
        }
        return { allowed: false };
      case JointInterviewEvent.START:
        if (currentState === JointInterviewStatus.SCHEDULED) {
          return { allowed: true, nextState: JointInterviewStatus.IN_PROGRESS };
        }
        return { allowed: false };
      case JointInterviewEvent.COMPLETE:
        if (currentState === JointInterviewStatus.IN_PROGRESS) {
          return { allowed: true, nextState: JointInterviewStatus.COMPLETED };
        }
        return { allowed: false };
      case JointInterviewEvent.VOID:
        if (
          currentState === JointInterviewStatus.SCHEDULED ||
          currentState === JointInterviewStatus.IN_PROGRESS
        ) {
          return { allowed: true, nextState: JointInterviewStatus.VOIDED };
        }
        return { allowed: false };
      case JointInterviewEvent.RESCHEDULE:
        if (currentState === JointInterviewStatus.VOIDED) {
          return { allowed: true, nextState: JointInterviewStatus.SCHEDULED };
        }
        return { allowed: false };
      default:
        return { allowed: false };
    }
  }
}
