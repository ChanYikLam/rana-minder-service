/**
 * 通知持久化端口定义（DATA-NTF-001、IFC-TX-002/005）。
 *
 * 通知事实、收件人快照、渠道投递意图和尝试在 PostgreSQL 持久化。
 * 通知事实与权益业务结果在同一事务保存；渠道投递在独立事务进行。
 */

import type {
  ChannelDeliveryAttemptModel,
  CreateNotificationFactInput,
  InboxPresentationModel,
  NotificationFactModel,
  RecipientSnapshot,
} from '../domain';

/** 通知事实事务保存结果 */
export interface NotificationFactTransactionResult {
  readonly fact: NotificationFactModel;
  readonly snapshots: readonly RecipientSnapshot[];
}

/**
 * 通知仓储端口。
 * 所有持久化操作都是原子的：保存失败即返回错误/抛异常，
 * 由调用方决定回滚整个业务事务（IFC-TX-002）。
 */
export interface NotificationRepository {
  /**
   * 在同一事务内保存通知事实、收件人快照和去重键。
   * 保存失败时抛出异常，调用方事务整体回滚。
   */
  saveFactWithSnapshots(
    input: CreateNotificationFactInput,
    snapshots: readonly RecipientSnapshot[],
  ): Promise<NotificationFactTransactionResult>;

  /**
   * 按逻辑事件＋收件人去重键查询已存在的事实（NTF-003）。
   */
  findFactByDedupKey(dedupKey: string): Promise<NotificationFactModel | null>;

  /**
   * 按通知事实标识查询。
   */
  findFactById(factId: string): Promise<NotificationFactModel | null>;

  /**
   * 更新通知事实状态。
   */
  updateFactStatus(
    factId: string,
    status: NotificationFactModel['status'],
    expectedVersion: number,
  ): Promise<NotificationFactModel>;

  /**
   * 查询待投递的通知事实（供站内信/邮件任务轮询）。
   */
  findFactsPendingDelivery(limit: number): Promise<readonly NotificationFactModel[]>;

  /**
   * 按通知事实标识查询关联的收件人快照。
   */
  findSnapshotsByFactId(factId: string): Promise<readonly RecipientSnapshot[]>;
}

/**
 * 站内信适配器端口。
 * 负责创建/确认唯一站内信呈现记录。
 */
export interface InboxAdapter {
  /**
   * 创建或确认唯一站内信呈现记录。
   * 同一逻辑事件＋收件人只对应一条站内信。
   */
  createOrConfirmPresentation(
    fact: NotificationFactModel,
    snapshot: RecipientSnapshot,
  ): Promise<InboxPresentationModel>;

  /**
   * 更新呈现子状态。
   */
  updatePresentationStatus(
    presentationId: string,
    status: InboxPresentationModel['status'],
    expectedVersion: number,
  ): Promise<InboxPresentationModel>;

  /**
   * 查询用户的通知列表。
   */
  listForUser(
    recipientId: string,
    cursor: string | null,
    limit: number,
  ): Promise<readonly InboxPresentationModel[]>;

  /**
   * 查询用户未读数。
   */
  countUnread(recipientId: string): Promise<number>;

  /**
   * 按呈现标识查询单条站内信（用于标记已读/已处理/隐藏）。
   */
  findPresentation(presentationId: string): Promise<InboxPresentationModel | null>;

  /**
   * 将收件人全部未读站内信标记为已读，逐条幂等，返回更新条数。
   */
  markAllRead(recipientId: string): Promise<number>;
}

/**
 * 邮件适配器端口。
 */
export interface EmailAdapter {
  /**
   * 发送邮件并返回渠道消息 ID。
   * 响应不确定时返回 null，由调用方回读提供商结果。
   */
  send(input: EmailSendInput): Promise<EmailSendResult>;
}

/** 邮件发送输入 */
export interface EmailSendInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly senderIdentity: string;
  readonly templateVersionId: string | null;
}

/** 邮件发送结果 */
export interface EmailSendResult {
  readonly status: 'SENT' | 'TEMPORARY_FAILURE' | 'BOUNCE' | 'UNCERTAIN';
  readonly channelMessageId: string | null;
  readonly sanitizedError: string | null;
}

/**
 * 渠道投递尝试仓储端口。
 */
export interface ChannelDeliveryAttemptRepository {
  /**
   * 保存新的渠道投递尝试。
   */
  saveAttempt(attempt: ChannelDeliveryAttemptModel): Promise<ChannelDeliveryAttemptModel>;

  /**
   * 更新尝试状态。
   */
  updateAttempt(
    attemptId: string,
    patch: Partial<ChannelDeliveryAttemptModel>,
  ): Promise<ChannelDeliveryAttemptModel>;

  /**
   * 查询失败重试中的尝试。
   */
  findRetryableAttempts(limit: number): Promise<readonly ChannelDeliveryAttemptModel[]>;
}

/**
 * 模板版本快照服务端口。
 */
export interface TemplateSnapshotService {
  /**
   * 冻结模板版本并返回版本标识。
   * 发送时冻结模板版本与发件身份（NTF-008/009）。
   */
  snapshotTemplate(kind: string, channel: 'INBOX' | 'EMAIL'): Promise<string>;
}
