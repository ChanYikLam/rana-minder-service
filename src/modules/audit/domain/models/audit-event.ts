/**
 * 审计事件类型目录（AUD-003：覆盖面——登录、资料同步、权限、社团接入、
 * 招新、联合、成员、表单、附件、通知、邮件密钥、纠错、导入导出、超管操作）。
 */
export const AuditEventType = {
  AUTH_LOGIN: 'AUTH_LOGIN',
  PROFILE_SYNC: 'PROFILE_SYNC',
  PERMISSION_CHANGE: 'PERMISSION_CHANGE',
  CLUB_ONBOARDING: 'CLUB_ONBOARDING',
  RECRUITMENT: 'RECRUITMENT',
  JOINT_ACTIVITY: 'JOINT_ACTIVITY',
  MEMBERSHIP: 'MEMBERSHIP',
  FORM_SUBMISSION: 'FORM_SUBMISSION',
  ATTACHMENT: 'ATTACHMENT',
  NOTIFICATION: 'NOTIFICATION',
  MAIL_CREDENTIAL: 'MAIL_CREDENTIAL',
  CORRECTION: 'CORRECTION',
  IMPORT_EXPORT: 'IMPORT_EXPORT',
  SUPER_ADMIN_OP: 'SUPER_ADMIN_OP',
} as const;

export type AuditEventType = (typeof AuditEventType)[keyof typeof AuditEventType];

/** 操作结果 */
export const AuditOutcome = {
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
  DENIED: 'DENIED',
} as const;

export type AuditOutcome = (typeof AuditOutcome)[keyof typeof AuditOutcome];

/** 来源（请求网络信息；AUD-003） */
export interface AuditSource {
  readonly ip?: string;
  readonly userAgent?: string;
  readonly channel: 'WEB' | 'ADMIN' | 'SYSTEM_TASK' | 'BATCH';
}

/**
 * 审计事件（AUD-003）。
 *
 * 字段：操作人、当时角色/作用域、时间、来源、关联对象、旧值/新值、
 * 结果、失败原因、请求编号及必要网络信息。
 * **敏感不落盘**：密码/邮箱密钥/令牌/验证码/附件正文不得进审计；
 * 敏感字段只记脱敏差异（由 AuditSanitizer 处理）。
 */
export interface AuditEvent {
  /** 唯一审计编号（不可变） */
  readonly auditId: string;
  readonly eventType: AuditEventType;
  /** 操作人 */
  readonly actorId: string;
  /** 当时角色/作用域（快照，不随当前角色变化） */
  readonly actorRoles: readonly string[];
  readonly scope: { kind: string; clubId?: string; unionId?: string } | null;
  readonly occurredAt: string;
  readonly source: AuditSource;
  /** 关联对象 */
  readonly target: { objectType: string; objectId: string } | null;
  /** 旧值/新值（脱敏差异） */
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly outcome: AuditOutcome;
  /** 失败原因（脱敏） */
  readonly failureReason?: string;
  /** 请求编号（关联业务请求） */
  readonly requestId: string;
  /** 附加脱敏上下文（不含敏感正文） */
  readonly sanitizedContext?: string;
}
