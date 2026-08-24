/**
 * HTTP 追踪请求头约定。
 *
 * 路径：src/platform/observability/interfaces/（PR #32 §2.2 B）。
 *
 * 约定：
 * - HTTP 入口在收到请求时读取 `X-Trace-Id`：合法 tr_ 编号即沿用，否则生成新的；
 * - HTTP 入口在响应头中回传 `X-Trace-Id`：让调用方/前端可串起日志；
 * - 不在请求体、URL 路径或 Cookie 中携带追踪编号（避免副作用 + 缓存副作用）。
 */

export const TRACE_ID_HEADER = 'X-Trace-Id';
