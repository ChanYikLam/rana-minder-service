/**
 * 通知持久化端口定义（DATA-NTF-001、IFC-TX-002/005、IFC-NTF-001）。
 *
 * 通知事实、收件人快照、渠道投递意图和尝试在 PostgreSQL 持久化。
 * 通知事实与权益业务结果在同一事务保存；渠道投递在独立事务进行。
 *
 * 站内信紧急关闭（SRS-FAIL-009）：关闭只暂停对应渠道呈现/投递，
 * 新通知事实和收件人仍创建；恢复按原事件时间升序补投并以
 * 逻辑事件＋收件人去重，不重复执行业务。
 */

import type {
  ChannelDeliveryAttemptModel,
  CreateNotificationFactInput,
  InboxPresentationModel,
  InboxPresentationStatus,
  KillSwitchScope,
  KillSwitchStateModel,
  NotificationFactModel,
  RecipientSnapshot,
} from '../domain';

/** 通知事实事务保存结果 */
export interface NotificationFactTransactionResult {
  readonly fact: NotificationFactModel;
  readonly snapshots: readonly RecipientSnapshot[];
}

/** 站内信列表筛选条件（NTF-003：类型筛选、未读筛选、隐藏列表） */
export interface InboxListFilter {
  /** 按通知类型筛选（null 表示不过滤） */
  readonly kind?: string | null;
  /** 仅未读 */
  readonly unreadOnly?: boolean;
  /** 包含隐藏（默认隐藏不展示在主列表） */
  readonly includeHidden?: boolean;
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
   * 查询紧急关闭范围内待投递的通知事实（SRS-FAIL-009）。
   * 平台范围匹配全部作用域；社团范围只匹配该社团 CLUB 作用域事实。
   */
  findFactsPendingDeliveryByKillScope(
    scope: KillSwitchScope,
    clubId: string | null,
    limit: number,
  ): Promise<readonly NotificationFactModel[]>;

  /**
   * 查询紧急关闭范围内暂停投递的通知事实，按原事件时间升序
   * （IFC-NTF-001：恢复后按原事件时间升序补投）。
   */
  findFactsPausedByKillScope(
    scope: KillSwitchScope,
    clubId: string | null,
    limit: number,
  ): Promise<readonly NotificationFactModel[]>;

  /**
   * 按通知事实查询收件人快照（补投时按快照创建/确认唯一呈现）。
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
   * 同一逻辑事件＋收件人只对应一条站内信（NTF-003）。
   */
  createOrConfirmPresentation(
    fact: NotificationFactModel,
    snapshot: RecipientSnapshot,
  ): Promise<InboxPresentationModel>;

  /**
   * 更新呈现子状态（已读/已处理/隐藏；PROCESSED/HIDDEN 为终态）。
   */
  updatePresentationStatus(
    presentationId: string,
    status: InboxPresentationStatus,
    expectedVersion: number,
  ): Promise<InboxPresentationModel>;

  /**
   * 全部标记已读（仅收件人本人，逐条幂等）。
   * 返回实际更新的条数。
   */
  markAllRead(recipientId: string): Promise<number>;

  /**
   * 查询用户的通知列表（类型筛选/未读筛选/隐藏列表）。
   */
  listForUser(
    recipientId: string,
    filter: InboxListFilter,
    cursor: string | null,
    limit: number,
  ): Promise<readonly InboxPresentationModel[]>;

  /**
   * 查询用户未读数。
   */
  countUnread(recipientId: string): Promise<number>;

  /**
   * 按呈现标识查询（校验本人归属与乐观锁版本用）。
   */
  findPresentation(presentationId: string): Promise<InboxPresentationModel | null>;
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

  /**
   * 按尝试标识查询（重试时直接定位指定尝试，不依赖队首顺序）。
   */
  findAttemptById(attemptId: string): Promise<ChannelDeliveryAttemptModel | null>;
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

/**
 * 站内信紧急关闭仓储端口（SRS-FAIL-009、DATA-NTF-001）。
 */
export interface KillSwitchRepository {
  /**
   * 保存/更新关闭状态（同范围保留首次 stoppedAt，active=false 表示已恢复）。
   */
  save(state: KillSwitchStateModel): Promise<KillSwitchStateModel>;

  /**
   * 查询指定范围的关闭记录（不区分是否活跃，用于查看历史）。
   */
  findByScope(scope: KillSwitchScope, clubId: string | null): Promise<KillSwitchStateModel | null>;

  /**
   * 按记录标识查询。
   */
  findById(switchId: string): Promise<KillSwitchStateModel | null>;
}

/**
 * 特权审计写入端口（需求发现 08：紧急关闭必须写入特权审计）。
 * 生产实现对接审计模块/PostgreSQL，内存桩仅用于开发阶段。
 */
export interface PrivilegedAuditWriter {
  /**
   * 写入一条特权审计记录，返回审计引用。
   * 审计保存失败时应抛出异常，由调用方决定是否中止命令。
   */
  write(entry: PrivilegedAuditEntry): Promise<string>;
}

/** 特权审计记录 */
export interface PrivilegedAuditEntry {
  readonly actorId: string;
  readonly actorName: string;
  readonly action: string;
  /** 影响范围描述（如 platform、club:xxx） */
  readonly scope: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly reason: string;
  readonly detail: Record<string, string>;
  readonly traceId: string | null;
  readonly occurredAt: string;
}

/**
 * 邮件配置存储端口（§14.4）。
 * 开发阶段为内存实现（未接入真实 SMTP 发送）；生产替换为持久化配置。
 */
export interface EmailConfigRecord {
  readonly clubId: string;
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly smtpUser: string;
  readonly fromName: string;
  readonly encryption: 'ssl' | 'tls' | 'none';
  readonly verified: boolean;
  readonly lastTestPassedAt: string | null;
  readonly keyRotatedAt: string | null;
  readonly savedAt: string;
}

export interface EmailConfigStore {
  findByClub(clubId: string): Promise<EmailConfigRecord | null>;
  save(config: EmailConfigRecord): Promise<EmailConfigRecord>;
}

/**
 * 通知偏好存储端口（§7：按用户真实落库）。
 */
export interface NotificationPreferencesStore {
  /** 读取用户偏好；未落库返回 null */
  get(userId: string): Promise<{ preferences: Record<string, boolean>; savedAt: string } | null>;
  set(userId: string, preferences: Record<string, boolean>): Promise<{ savedAt: string }>;
}
