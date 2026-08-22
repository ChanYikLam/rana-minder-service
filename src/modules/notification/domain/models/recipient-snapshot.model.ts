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

/** 构建去重键 */
export function buildDedupKey(logicalEventId: string, recipientId: string): string {
  return `${logicalEventId}\u0000${recipientId}`;
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
