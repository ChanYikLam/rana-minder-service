/**
 * 传输层执行主体上下文（interfaces 层；AUT 分面）。
 *
 * subjectId 恒来自认证会话解析结果，不采纳请求方自报身份；now 为服务端当前
 * 时间；traceId 复用追踪上下文（缺失时生成并透传至审计）。
 */

export type ActorKind = 'user' | 'system';

export interface ActorContext {
  readonly subjectId: string;
  readonly now: Date;
  readonly traceId: string;
  /** 主体类型：用户（会话来源）或系统（后台任务/服务回调），用于区分授权与审计来源 */
  readonly kind: ActorKind;
}

/** 系统主体（非会话来源，例如邀请服务回调、后台任务）的标识前缀 */
export const SYSTEM_INVITATION_WEBHOOK = 'system:invitation-webhook';

/** 构造系统主体。永远不应作为普通用户会话主体使用（区别于 kind='user'）。 */
export function systemActor(now: Date, traceId = ''): ActorContext {
  return { subjectId: SYSTEM_INVITATION_WEBHOOK, now, traceId, kind: 'system' };
}
