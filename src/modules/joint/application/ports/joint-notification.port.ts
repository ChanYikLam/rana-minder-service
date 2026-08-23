/**
 * 联合通知端口（joint 应用层；3.x 通知中心接入前的失败关闭桩）。
 */

export interface JointNotificationInput {
  readonly recipientId: string;
  readonly template: string;
  readonly payload: Record<string, unknown>;
}

export interface JointNotificationPort {
  /** 发送通知；返回通知回执标识或 null（未接入）。 */
  notify(input: JointNotificationInput): Promise<string | null>;
}

export class NotWiredJointNotification implements JointNotificationPort {
  async notify(): Promise<string | null> {
    return null;
  }
}
