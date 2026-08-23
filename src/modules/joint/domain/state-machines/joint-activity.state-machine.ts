/**
 * 联合活动主状态机（JNT-001；SRS-SM-JNT-001）。
 *
 * 关键约束：
 * - 草拟/待确认 → 全体确认成立 → 首次公布 → 邀请阶段 → 结束确认 → 已结束
 * - 任意非终态可被超管强制结束（FORCE_ENDED）
 * - 草拟/待确认且尚无首邀时可全体取消确认 → 已取消
 * - 首次公布是单向门（名单永久锁定），首邀是单向门（禁止取消整个活动）
 * - 取消与首邀互斥，靠乐观锁单胜者（应用层保证）
 */

export enum JointActivityStatus {
  DRAFT_CONFIRMING = 'DRAFT_CONFIRMING',
  ESTABLISHED = 'ESTABLISHED',
  PUBLISHED = 'PUBLISHED',
  INVITING = 'INVITING',
  END_CONFIRMING = 'END_CONFIRMING',
  ENDED = 'ENDED',
  CANCELLED = 'CANCELLED',
  FORCE_ENDED = 'FORCE_ENDED',
}

export enum JointActivityEvent {
  CONFIRM_ALL = 'CONFIRM_ALL',
  PUBLISH = 'PUBLISH',
  SEND_FIRST_INVITATION = 'SEND_FIRST_INVITATION',
  CANCEL_ALL = 'CANCEL_ALL',
  BEGIN_END_CONFIRM = 'BEGIN_END_CONFIRM',
  END = 'END',
  FORCE_END = 'FORCE_END',
}

const TERMINAL = new Set<JointActivityStatus>([
  JointActivityStatus.ENDED,
  JointActivityStatus.CANCELLED,
  JointActivityStatus.FORCE_ENDED,
]);

export interface JointActivityTransition {
  readonly allowed: boolean;
  readonly nextState?: JointActivityStatus;
}

export class JointActivityStateMachine {
  transition(input: {
    event: JointActivityEvent;
    currentState: JointActivityStatus;
  }): JointActivityTransition {
    const { event, currentState } = input;
    if (TERMINAL.has(currentState)) {
      if (event === JointActivityEvent.FORCE_END) {
        return { allowed: true, nextState: JointActivityStatus.FORCE_ENDED };
      }
      return { allowed: false };
    }
    switch (event) {
      case JointActivityEvent.CONFIRM_ALL:
        if (currentState === JointActivityStatus.DRAFT_CONFIRMING) {
          return { allowed: true, nextState: JointActivityStatus.ESTABLISHED };
        }
        return { allowed: false };
      case JointActivityEvent.PUBLISH:
        if (currentState === JointActivityStatus.ESTABLISHED) {
          return { allowed: true, nextState: JointActivityStatus.PUBLISHED };
        }
        return { allowed: false };
      case JointActivityEvent.SEND_FIRST_INVITATION:
        if (currentState === JointActivityStatus.PUBLISHED) {
          return { allowed: true, nextState: JointActivityStatus.INVITING };
        }
        return { allowed: false };
      case JointActivityEvent.CANCEL_ALL:
        if (currentState === JointActivityStatus.DRAFT_CONFIRMING) {
          return { allowed: true, nextState: JointActivityStatus.CANCELLED };
        }
        return { allowed: false };
      case JointActivityEvent.BEGIN_END_CONFIRM:
        if (currentState === JointActivityStatus.INVITING) {
          return { allowed: true, nextState: JointActivityStatus.END_CONFIRMING };
        }
        return { allowed: false };
      case JointActivityEvent.END:
        if (currentState === JointActivityStatus.END_CONFIRMING) {
          return { allowed: true, nextState: JointActivityStatus.ENDED };
        }
        return { allowed: false };
      case JointActivityEvent.FORCE_END:
        return { allowed: true, nextState: JointActivityStatus.FORCE_ENDED };
      default:
        return { allowed: false };
    }
  }
}
