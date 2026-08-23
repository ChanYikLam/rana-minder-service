/**
 * 联合报名通道状态机（JNT-006；SRS-SM-JNT-006）。
 *
 * 独立四态通道：未开放/开放/暂停/已关闭，不并入活动主状态，不复用普通报名通道。
 * 暂停废止旧截止窗口；恢复须设新截止并创建新窗口；截止任务自动关闭；非终态可重开新窗口。
 */

export enum JointChannelStatus {
  NOT_OPEN = 'NOT_OPEN',
  OPEN = 'OPEN',
  SUSPENDED = 'SUSPENDED',
  CLOSED_FINAL = 'CLOSED_FINAL',
}

export enum JointChannelEvent {
  OPEN = 'OPEN',
  SUSPEND = 'SUSPEND',
  RESUME = 'RESUME',
  EXTEND = 'EXTEND',
  CLOSE = 'CLOSE',
  REOPEN = 'REOPEN',
}

export interface JointChannelTransition {
  readonly allowed: boolean;
  readonly nextState?: JointChannelStatus;
}

export class JointChannelStateMachine {
  transition(input: {
    event: JointChannelEvent;
    currentState: JointChannelStatus;
  }): JointChannelTransition {
    const { event, currentState } = input;
    switch (event) {
      case JointChannelEvent.OPEN:
        if (currentState === JointChannelStatus.NOT_OPEN) {
          return { allowed: true, nextState: JointChannelStatus.OPEN };
        }
        return { allowed: false };
      case JointChannelEvent.SUSPEND:
        if (currentState === JointChannelStatus.OPEN) {
          return { allowed: true, nextState: JointChannelStatus.SUSPENDED };
        }
        return { allowed: false };
      case JointChannelEvent.RESUME:
        if (currentState === JointChannelStatus.SUSPENDED) {
          return { allowed: true, nextState: JointChannelStatus.OPEN };
        }
        return { allowed: false };
      case JointChannelEvent.EXTEND:
        if (currentState === JointChannelStatus.OPEN) {
          return { allowed: true, nextState: JointChannelStatus.OPEN };
        }
        return { allowed: false };
      case JointChannelEvent.CLOSE:
        if (
          currentState === JointChannelStatus.OPEN ||
          currentState === JointChannelStatus.SUSPENDED
        ) {
          return { allowed: true, nextState: JointChannelStatus.CLOSED_FINAL };
        }
        return { allowed: false };
      case JointChannelEvent.REOPEN:
        if (currentState === JointChannelStatus.CLOSED_FINAL) {
          return { allowed: true, nextState: JointChannelStatus.OPEN };
        }
        return { allowed: false };
      default:
        return { allowed: false };
    }
  }
}
