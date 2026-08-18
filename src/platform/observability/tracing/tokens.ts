/**
 * observability/tracing 子模块的 DI 标识符。
 *
 * 字符串标识符约定同 src/config/tokens.ts（避免 Symbol 序列化与跨进程比较歧义）。
 */

export const SPAN_LINK = 'OBSERVABILITY_SPAN_LINK';
export const CORRELATION = 'OBSERVABILITY_CORRELATION';
export const TRACE_CONTEXT = 'OBSERVABILITY_TRACE_CONTEXT';
