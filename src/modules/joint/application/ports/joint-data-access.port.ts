/**
 * 联合配置与通知端口（joint 应用层；CFG-002 截止窗口驱动 + 消息通知）。
 *
 * 配置端口读取全局截止窗口/短确认期限；通知端口用于确认截止提醒、邀请超时等异步通知。
 */

export interface JointConfigPort {
  /** 联合活动确认截止/短确认期限（ms，来自 CFG-002 配置） */
  getConfirmDeadlineMs(): Promise<number>;
}

export interface JointNotificationPort {
  notifyConfirmDeadline(input: { activityId: string; clubIds: string[] }): Promise<void>;
  notifyInvitationTimeout(input: { activityId: string; clubId: string }): Promise<void>;
}

export class NotWiredJointConfig implements JointConfigPort {
  async getConfirmDeadlineMs(): Promise<number> {
    return 7 * 24 * 60 * 60 * 1000;
  }
}

export class NotWiredJointNotification implements JointNotificationPort {
  async notifyConfirmDeadline(): Promise<void> {
    /* noop until 3.x wiring */
  }
  async notifyInvitationTimeout(): Promise<void> {
    /* noop until 3.x wiring */
  }
}
