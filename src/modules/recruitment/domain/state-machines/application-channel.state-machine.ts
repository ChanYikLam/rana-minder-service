/**
 * 报名通道状态机（recruitment 域；REC-002、SRS-SM-REC-002）。
 *
 * 四态：NOT_STARTED（未开放）→ OPEN → PAUSED / CLOSED；关闭后活动仍进行中时
 * 可携合法新截止重开新窗口（CLOSED → OPEN，须新截止严格晚于重开提交时刻；
 * 因活动完成/取消/强制完成而关闭的通道由应用层活动状态校验兜底拒绝）。
 * 暂停仅停新报名和申请人修改，已安排面试与评审继续。
 */

export const ApplicationChannelStatus = {
  NOT_STARTED: 'NOT_STARTED',
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

/** 转换输入（含 SRS-SM-REC-002 重开守卫上下文） */
export interface ChannelTransitionInput {
  readonly event: ApplicationChannelEvent;
  readonly currentState: ApplicationChannelStatus;
  /**
   * 重开守卫：新截止严格晚于重开提交时刻（SRS-SM-REC-002 拒绝条件
   * 「新截止缺失/越界/不晚于重开时刻」）。仅 CLOSED → OPEN 必需。
   */
  readonly newDeadlineStrictlyAfterNow?: boolean;
}

export interface ChannelTransitionResult {
  readonly allowed: boolean;
  readonly nextState: ApplicationChannelStatus;
}

export interface ApplicationChannelStateMachine {
  transition(input: ChannelTransitionInput): ChannelTransitionResult;
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
    NOT_STARTED: {
      OPEN: ApplicationChannelStatus.OPEN,
      CLOSE: ApplicationChannelStatus.CLOSED,
    },
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

  transition(input: ChannelTransitionInput): ChannelTransitionResult {
    // 重开守卫（SRS-SM-REC-002）：已关闭 → 开放必须携合法新截止，
    // 区别于「未开放 → 开放」的首次开放
    if (
      input.currentState === ApplicationChannelStatus.CLOSED &&
      input.event === ApplicationChannelEvent.OPEN &&
      input.newDeadlineStrictlyAfterNow !== true
    ) {
      return { allowed: false, nextState: input.currentState };
    }
    const next = this.table[input.currentState]?.[input.event];
    if (next === undefined) {
      return { allowed: false, nextState: input.currentState };
    }
    return { allowed: true, nextState: next };
  }
}
