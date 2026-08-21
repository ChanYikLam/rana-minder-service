/**
 * 站内信呈现模型（NTF-003、SRS-SM-NTF-001）。
 *
 * 站内信呈现是通知事实在收件人视角的投影。权益通知不可物理删除，
 * 但可归入已处理或隐藏列表。同一逻辑事件的重复投递只对应一条站内信。
 */

/** 站内信呈现子状态 */
export type InboxPresentationStatus = 'READ' | 'UNREAD' | 'PROCESSED' | 'HIDDEN';

/** 有期限通知的办理状态 */
export type DeadlineStatus = 'ACTIONABLE' | 'PROCESSED' | 'WITHDRAWN' | 'EXPIRED';

/** 站内信呈现 */
export interface InboxPresentationModel {
  /** 呈现标识（UUIDv7） */
  readonly presentationId: string;
  /** 所属通知事实标识 */
  readonly factId: string;
  /** 收件人主体标识 */
  readonly recipientId: string;
  /** 呈现子状态 */
  readonly status: InboxPresentationStatus;
  /** 有期限通知的办理状态（可选） */
  readonly deadlineStatus: DeadlineStatus | null;
  /** 通知类型 */
  readonly eventType: string;
  /** 标题 */
  readonly title: string;
  /** 正文（最小摘要） */
  readonly body: string;
  /** 业务链接（每次打开重新鉴权） */
  readonly link: string | null;
  /** 所属社团名称（用于展示） */
  readonly clubName: string | null;
  /** 投递时间 */
  readonly deliveredAt: string;
  /** 已读时间 */
  readonly readAt: string | null;
  /** 呈现版本 */
  readonly version: number;
}

/**
 * 验证是否可以标记为特定子状态。
 * 返回 null 表示合法，否则返回拒绝原因。
 */
export function validatePresentationStatusTransition(
  current: InboxPresentationStatus,
  target: InboxPresentationStatus,
): string | null {
  // 已处理或隐藏不可逆回未读
  if (current === 'PROCESSED' && target !== 'PROCESSED') {
    return '已处理的通知不可逆回' + target;
  }
  if (current === 'HIDDEN' && target !== 'HIDDEN') {
    return '已隐藏的通知不可逆回' + target;
  }
  return null;
}
