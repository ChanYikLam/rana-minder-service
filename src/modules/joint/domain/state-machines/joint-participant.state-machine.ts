/**
 * 参与社团关系状态机（JNT-002；SRS-SM-JNT-002）。
 *
 * 关键约束：
 * - 拟参与 → 本轮确认 → 首次公布后固化正式参与
 * - 公布前可撤回意向；公布后不可新增/退出/替换，只能紧急停用/恢复
 * - 确认轮次不匹配（名单变化/超时）进入待重确认
 * - 紧急停用不删除参与身份，恢复按停用时长顺延
 */

export enum JointParticipantStatus {
  PROPOSED = 'PROPOSED',
  CONFIRMED = 'CONFIRMED',
  STALE_RECONFIRM = 'STALE_RECONFIRM',
  PARTICIPATING = 'PARTICIPATING',
  EMERGENCY_SUSPENDED = 'EMERGENCY_SUSPENDED',
  WITHDRAWN = 'WITHDRAWN',
}

export enum JointParticipantEvent {
  CONFIRM = 'CONFIRM',
  STALE = 'STALE',
  RECONFIRM = 'RECONFIRM',
  PARTICIPATE = 'PARTICIPATE',
  WITHDRAW = 'WITHDRAW',
  REPROPOSE = 'REPROPOSE',
  SUSPEND = 'SUSPEND',
  RESUME = 'RESUME',
}

export interface JointParticipantTransition {
  readonly allowed: boolean;
  readonly nextState?: JointParticipantStatus;
}

export class JointParticipantStateMachine {
  transition(input: {
    event: JointParticipantEvent;
    currentState: JointParticipantStatus;
  }): JointParticipantTransition {
    const { event, currentState } = input;
    switch (event) {
      case JointParticipantEvent.CONFIRM:
        if (currentState === JointParticipantStatus.PROPOSED) {
          return { allowed: true, nextState: JointParticipantStatus.CONFIRMED };
        }
        return { allowed: false };
      case JointParticipantEvent.STALE:
        if (currentState === JointParticipantStatus.CONFIRMED) {
          return { allowed: true, nextState: JointParticipantStatus.STALE_RECONFIRM };
        }
        return { allowed: false };
      case JointParticipantEvent.RECONFIRM:
        if (currentState === JointParticipantStatus.STALE_RECONFIRM) {
          return { allowed: true, nextState: JointParticipantStatus.CONFIRMED };
        }
        return { allowed: false };
      case JointParticipantEvent.PARTICIPATE:
        if (currentState === JointParticipantStatus.CONFIRMED) {
          return { allowed: true, nextState: JointParticipantStatus.PARTICIPATING };
        }
        return { allowed: false };
      case JointParticipantEvent.WITHDRAW:
        if (currentState === JointParticipantStatus.PROPOSED) {
          return { allowed: true, nextState: JointParticipantStatus.WITHDRAWN };
        }
        return { allowed: false };
      case JointParticipantEvent.REPROPOSE:
        if (currentState === JointParticipantStatus.WITHDRAWN) {
          return { allowed: true, nextState: JointParticipantStatus.PROPOSED };
        }
        return { allowed: false };
      case JointParticipantEvent.SUSPEND:
        if (currentState === JointParticipantStatus.PARTICIPATING) {
          return { allowed: true, nextState: JointParticipantStatus.EMERGENCY_SUSPENDED };
        }
        return { allowed: false };
      case JointParticipantEvent.RESUME:
        if (currentState === JointParticipantStatus.EMERGENCY_SUSPENDED) {
          return { allowed: true, nextState: JointParticipantStatus.PARTICIPATING };
        }
        return { allowed: false };
      default:
        return { allowed: false };
    }
  }
}
