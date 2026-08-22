/**
 * 传输层执行主体上下文（interfaces 层；AUT 分面）。
 *
 * subjectId 恒来自认证会话解析结果，不采纳请求方自报身份；now 为服务端当前
 * 时间；traceId 复用追踪上下文（缺失时生成并透传至审计）。
 */

export interface ActorContext {
  readonly subjectId: string;
  readonly now: Date;
  readonly traceId: string;
}
