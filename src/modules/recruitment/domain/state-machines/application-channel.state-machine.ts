/**
 * 报名通道状态机（recruitment 域；REC-002、SRS-SM-REC-002）。
 *
 * 四态：CLOSED → OPEN → PAUSED / CLOSED；关闭后活动仍进行中时可携合法新截止
 * 重开新窗口（CLOSED → OPEN）。暂停仅停新报名和申请人修改，已安排面试与评审继续。
 */

export const ApplicationChannelStatus = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  PAUSED: 'PAUSED',
} as const;
export type ApplicationChannelStatus =
  (typeof ApplicationChannelStatus)[keyof typeof ApplicationChannelStatus];

export const ApplicationChannelEvent = {
  OPEN: 'OPEN',
  PAUSE: 'PAUSE',
  RESUME: 'RESUME',
  CLOSE: 'CLOSE',
} as const;
export type ApplicationChannelEvent =
  (typeof ApplicationChannelEvent)[keyof typeof ApplicationChannelEvent];

export interface ChannelTransitionResult {
  readonly allowed: boolean;
  readonly nextState: ApplicationChannelStatus;
}

export interface ApplicationChannelStateMachine {
  transition(input: {
    readonly event: ApplicationChannelEvent;
    readonly currentState: ApplicationChannelStatus;
  }): ChannelTransitionResult;
}

export class DefaultApplicationChannelStateMachine implements ApplicationChannelStateMachine {
  private readonly table: Readonly<
    Partial<
      Record<
        ApplicationChannelStatus,
        Partial<Record<ApplicationChannelEvent, ApplicationChannelStatus>>
      >
    >
  > = {
    CLOSED: { OPEN: ApplicationChannelStatus.OPEN },
    OPEN: {
      PAUSE: ApplicationChannelStatus.PAUSED,
      CLOSE: ApplicationChannelStatus.CLOSED,
    },
    PAUSED: {
      RESUME: ApplicationChannelStatus.OPEN,
      CLOSE: ApplicationChannelStatus.CLOSED,
    },
  };

  transition(input: {
    readonly event: ApplicationChannelEvent;
    readonly currentState: ApplicationChannelStatus;
  }): ChannelTransitionResult {
    const next = this.table[input.currentState]?.[input.event];
    if (next === undefined) {
      return { allowed: false, nextState: input.currentState };
    }
    return { allowed: true, nextState: next };
  }
}
