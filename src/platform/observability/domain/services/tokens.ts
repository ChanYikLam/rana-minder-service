/**
 * observability 领域服务的 DI 标识符。
 *
 * 字符串标识符约定同 src/config/tokens.ts（避免 Symbol 序列化与跨进程比较歧义）。
 *
 * 当前已注册：redaction.rules / retention.rules / trace-id.generator。
 * 后续 MR（logging / tracing / status-page）会按需追加。
 */

export const REDACTION_RULES = 'OBSERVABILITY_REDACTION_RULES';
export const RETENTION_RULES = 'OBSERVABILITY_RETENTION_RULES';
export const TRACE_ID_GENERATOR = 'OBSERVABILITY_TRACE_ID_GENERATOR';