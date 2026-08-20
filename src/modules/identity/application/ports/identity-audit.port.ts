/**
 * 身份域业务审计端口（ENG-004 §4、AUD-003）。
 *
 * 关键变化（账号禁用/删除/恢复/降级、资料保存、同步收口/回退/冲突、姓名更正、
 * 邮箱验证）必须与业务提交同边界落不可变审计事实；审计保存失败时原命令回滚。
 * 审计载荷只保存脱敏摘要与引用，不保存令牌、附件正文或完整个人资料。
 */

export type IdentityAuditFactType =
  | 'ACCOUNT_ACCESS_CHANGED'
  | 'PROFILE_SAVED'
  | 'PROFILE_SYNC_OUTCOME'
  | 'PROFILE_SYNC_CONFLICT'
  | 'EMAIL_VERIFICATION'
  | 'NAME_CORRECTION';

export interface IdentityAuditFact {
  readonly type: IdentityAuditFactType;
  readonly subjectId: string;
  readonly occurredAt: Date;
  /** 操作者（本人/系统任务/超管） */
  readonly actor: string;
  /** 脱敏摘要：只含稳定标识、状态、字段名、版本与最小原因 */
  readonly summary: Record<string, unknown>;
  /** 来源追踪（请求 supportId / 任务追踪编号） */
  readonly traceId: string | null;
}

export interface IdentityAuditPort {
  record(fact: IdentityAuditFact): Promise<void>;
}