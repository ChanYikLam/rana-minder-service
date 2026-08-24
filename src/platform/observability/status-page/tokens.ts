/**
 * observability/status-page 子模块的 DI 标识符。
 *
 * 字符串标识符约定同 src/config/tokens.ts（避免 Symbol 序列化与跨进程比较歧义）。
 *
 * 端口（DB/任务/适配器）当前均为桩实现：未连接时返回 'unknown'，状态页显式
 * 显示"未知"（ADR-011 §2.1 第 2 条）。真实实现在 src/database/、src/platform/
 * jobs/、src/adapters/ 解锁后注入（DEP-Q-001/002 / A 任务模块就绪）。
 */

export const STALE_UNKNOWN_RULE = 'OBSERVABILITY_STALE_UNKNOWN_RULE';
export const APP_STATUS_PORT = 'OBSERVABILITY_APP_STATUS_PORT';
export const DB_STATUS_PORT = 'OBSERVABILITY_DB_STATUS_PORT';
export const TASK_SUMMARY_PORT = 'OBSERVABILITY_TASK_SUMMARY_PORT';
export const DEP_LATEST_PORT = 'OBSERVABILITY_DEP_LATEST_PORT';
export const STATUS_PAGE_AUTHORIZER = 'OBSERVABILITY_STATUS_PAGE_AUTHORIZER';
export const STATUS_SUMMARY_QUERY = 'OBSERVABILITY_STATUS_SUMMARY_QUERY';
