/**
 * 收件人快照领域模型（NTF-002）。
 *
 * 收件人名单在业务事件发生时形成快照，后续换届不改变历史收件人。
 * 每个收件人快照记录：通知事实、收件人主体、当时收件原因、
 * 社团/联合/平台范围和去重键。
 */

/** 收件人快照 */
export interface RecipientSnapshot {
  /** 快照标识（UUIDv7） */
  readonly snapshotId: string;
  /** 所属通知事实标识 */
  readonly factId: string;
  /** 收件人主体标识 */
  readonly recipientId: string;
  /** 当时收件原因（如"本人"、"社团负责人"、"人事管理员"、"部门负责人"） */
  readonly reason: string;
  /** 作用域 */
  readonly scope: RecipientScope;
  /**
   * 去重键：逻辑事件＋收件人唯一。
   * 格式：`${logicalEventId}:${recipientId}`
   * 分隔符使用 ':'（PostgreSQL text 列禁止 NUL 字节；见 4.3 收口评审 C1）。
   */
  readonly dedupKey: string;
  /** 创建时间 */
  readonly createdAt: string;
}

/** 收件人作用域 */
export interface RecipientScope {
  readonly type: 'CLUB' | 'PLATFORM' | 'JOINT';
  readonly clubId: string | null;
}

/**
 * 构建去重键（逻辑事件＋收件人唯一；':' 分隔，Postgres text 可安全存储）。
 *
 * 分隔符选用 ':'（Postgres text 禁止 NUL 字节，故不能用 '\0'）。虽理论上存在
 * `a:b`+`c` 与 `a`+`b:c` 的拼接歧义，但实际两段均由 UUID 派生（logicalEventId
 * 内嵌 attemptId/factId，recipientId 为 UUIDv7），均不含 ':'，因此无碰撞风险；
 * 若未来引入可含 ':' 的段，需改用不可见分隔符（如 '\x1F'）。
 */
export function buildDedupKey(logicalEventId: string, recipientId: string): string {
  return `${logicalEventId}:${recipientId}`;
}

/** 收件人解析输入 */
export interface RecipientResolveInput {
  /** 事件类型 */
  readonly eventType: string;
  /** 业务对象标识 */
  readonly sourceObjectId: string;
  /** 作用域 */
  readonly scope: RecipientScope;
  /** 操作者标识 */
  readonly operatorId: string;
  /** 目标学生标识（可选，如邀请对象） */
  readonly targetStudentId?: string;
  /** 额外上下文（如部门标识、活动标识） */
  readonly context?: Record<string, string>;
}

/** 收件人解析结果 */
export interface RecipientResolveResult {
  /** 收件人列表 */
  readonly recipients: readonly Omit<RecipientSnapshot, 'snapshotId' | 'factId' | 'createdAt'>[];
  /** 解析依据（用于审计） */
  readonly resolutionRationale: string;
}
