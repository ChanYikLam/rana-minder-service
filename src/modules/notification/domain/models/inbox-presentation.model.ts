/**
 * 站内信呈现模型（NTF-003、SRS-SM-NTF-001）。
 *
 * 站内信呈现是通知事实在收件人视角的投影。权益通知不可物理删除，
 * 但可归入已处理或隐藏列表。同一逻辑事件的重复投递只对应一条站内信。
 *
 * 有期限通知的当前办理状态（可处理/已处理/已撤回/已过期）在查询时
 * 按 `resolveEffectiveDeadlineStatus` 推导：已处理/已撤回为终态不被时间
 * 覆盖，其余在超过期限后显示已过期；过期后保留历史（需求发现 08）。
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
  /** 有期限通知的办理状态（可选；终态不被时间覆盖） */
  readonly deadlineStatus: DeadlineStatus | null;
  /** 有期限通知的截止时间（可选） */
  readonly deadlineAt: string | null;
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
  /** 已处理时间 */
  readonly processedAt: string | null;
  /** 隐藏时间 */
  readonly hiddenAt: string | null;
  /** 呈现版本 */
  readonly version: number;
}

/**
 * 验证是否可以标记为特定子状态（NTF-003）。
 * 返回 null 表示合法，否则返回拒绝原因。
 *
 * 规则：
 * - 已处理/已隐藏为终态，不可逆回其他状态；
 * - 已读可幂等重复（重复标记不报错）；
 * - 未投递（UNREAD 且未生成）不在此校验，由状态机在命令层把关。
 */
export function validatePresentationStatusTransition(
  current: InboxPresentationStatus,
  target: InboxPresentationStatus,
): string | null {
  // 已处理或隐藏不可逆回未读/已读
  if (current === 'PROCESSED' && target !== 'PROCESSED') {
    return '已处理的通知不可逆回' + target;
  }
  if (current === 'HIDDEN' && target !== 'HIDDEN') {
    return '已隐藏的通知不可逆回' + target;
  }
  return null;
}

/**
 * 推导有期限通知的当前办理状态（NTF-003）。
 *
 * - 已处理/已撤回为终态，保持原状态（过期后保留历史）；
 * - 其余状态在超过截止时间后显示已过期；
 * - 未存储状态且未过期时显示可处理。
 */
export function resolveEffectiveDeadlineStatus(
  stored: DeadlineStatus | null,
  deadlineAt: string | null,
  now: string,
): DeadlineStatus | null {
  if (!deadlineAt) return stored;
  if (stored === 'PROCESSED' || stored === 'WITHDRAWN') return stored;
  if (deadlineAt <= now) return 'EXPIRED';
  return stored ?? 'ACTIONABLE';
}
