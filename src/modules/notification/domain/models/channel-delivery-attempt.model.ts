/**
 * 渠道投递尝试领域模型（NTF-001、NTF-007、IFC-TX-005）。
 *
 * 渠道投递尝试记录每次站内信或邮件投递的尝试结果。
 * 渠道投递失败不回滚已生效业务；持续重试失败投递并允许人工补发，
 * 补发只重发通知不重执行原业务。
 */

/** 渠道类型 */
export type ChannelType = 'INBOX' | 'EMAIL';

/** 渠道投递状态 */
export type ChannelDeliveryStatus = 'PENDING' | 'DELIVERED' | 'FAILED_RETRY' | 'PERMANENT_FAILURE';

/** 渠道投递尝试 */
export interface ChannelDeliveryAttemptModel {
  /** 尝试标识（UUIDv7） */
  readonly attemptId: string;
  /** 所属通知事实标识 */
  readonly factId: string;
  /** 收件人快照标识（投递尝试可回溯收件人快照，保证关联完整性） */
  readonly snapshotId: string | null;
  /** 收件人主体标识（外发箱展示与永久失败提示定位；快照的冗余引用） */
  readonly recipientId?: string | null;
  /** 渠道类型 */
  readonly channel: ChannelType;
  /** 渠道消息 ID（外部投递标识，用于幂等） */
  readonly channelMessageId: string | null;
  /** 尝试序号 */
  readonly attemptNumber: number;
  /** 当前状态 */
  readonly status: ChannelDeliveryStatus;
  /** 目标地址（站内信为 null；邮件为目标邮箱） */
  readonly targetAddress: string | null;
  /** 模板版本快照引用 */
  readonly templateVersionId: string | null;
  /** 发件身份快照 */
  readonly senderIdentity: string | null;
  /** 邮件标题快照（重试时复用，避免空内容，NTF-002 最少摘要） */
  readonly emailSubject: string | null;
  /** 邮件正文快照（重试时复用，避免空内容，NTF-002 最少摘要） */
  readonly emailBody: string | null;
  /** 首次失败时间（连续失败 24 小时停止重试的窗口起点，NTF-007） */
  readonly firstFailedAt: string | null;
  /** 响应类别 */
  readonly responseCategory: ChannelResponseCategory | null;
  /** 脱敏错误信息 */
  readonly sanitizedError: string | null;
  /** 下次重试时间 */
  readonly nextRetryAt: string | null;
  /** 尝试创建时间 */
  readonly createdAt: string;
  /** 完成时间 */
  readonly completedAt: string | null;
  /** 版本号 */
  readonly version: number;
}

/** 投递响应类别 */
export type ChannelResponseCategory =
  'SUCCESS' | 'TEMPORARY_FAILURE' | 'BOUNCE' | 'PERMANENT_FAILURE' | 'UNCERTAIN';

/** 邮件投递资格评估输入 */
export interface EmailEligibilityInput {
  /** 事件是否允许邮件 */
  readonly eventAllowsEmail: boolean;
  /** 本次/活动配置是否关闭邮件 */
  readonly configClosedEmail: boolean;
  /** 用户是否退订普通邮件 */
  readonly userUnsubscribed: boolean;
  /** 邮箱是否已验证 */
  readonly emailVerified: boolean;
  /** 发信账号是否有效 */
  readonly senderAccountValid: boolean;
}

/** 邮件投递资格评估结果 */
export interface EmailEligibilityResult {
  /** 是否具备邮件投递资格 */
  readonly eligible: boolean;
  /** 不具资格原因 */
  readonly reason: string | null;
}

/**
 * 评估邮件投递资格（NTF-004 至 NTF-007）。
 */
export function evaluateEmailEligibility(input: EmailEligibilityInput): EmailEligibilityResult {
  if (!input.eventAllowsEmail) {
    return { eligible: false, reason: '事件不允许邮件投递' };
  }
  if (input.configClosedEmail) {
    return { eligible: false, reason: '本次/活动配置已关闭邮件' };
  }
  if (input.userUnsubscribed) {
    return { eligible: false, reason: '用户已退订普通业务邮件' };
  }
  if (!input.emailVerified) {
    return { eligible: false, reason: '邮箱未验证' };
  }
  if (!input.senderAccountValid) {
    return { eligible: false, reason: '发信账号无效' };
  }
  return { eligible: true, reason: null };
}

/** 判断是否应停止邮件重试（NTF-007） */
export function shouldStopEmailRetry(input: {
  readonly responseCategory: ChannelResponseCategory;
  readonly firstFailureAt: string;
  readonly now: string;
}): boolean {
  if (input.responseCategory === 'BOUNCE') return true;
  if (input.responseCategory === 'PERMANENT_FAILURE') return true;
  // 连续失败 24 小时后停止：窗口从首次失败时刻起算（NTF-007）
  const firstFailure = new Date(input.firstFailureAt).getTime();
  const now = new Date(input.now).getTime();
  const hours = (now - firstFailure) / (1000 * 60 * 60);
  return hours >= 24;
}

/**
 * 计算下次重试时间（指数退避，最多 6 小时）。
 * attemptNumber 为刚失败的尝试序号：第 1 次失败后等 2 分钟，
 * 之后按 2^N 递增（2、4、8…分钟），封顶 6 小时（NTF-007）。
 * 所有邮件投递/重试路径共用本函数，避免退避口径不一致。
 */
export function computeNextRetryAt(attemptNumber: number, now: string): string {
  const minutes = Math.min(2 ** attemptNumber, 60 * 6);
  return new Date(new Date(now).getTime() + minutes * 60 * 1000).toISOString();
}
