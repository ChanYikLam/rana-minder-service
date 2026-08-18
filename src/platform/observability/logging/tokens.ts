/**
 * observability/logging 子模块的 DI 标识符。
 *
 * 字符串标识符约定同 src/config/tokens.ts（避免 Symbol 序列化与跨进程比较歧义）。
 */

export const LOG_SANITIZER = 'OBSERVABILITY_LOG_SANITIZER';
export const APP_LOGGER = 'OBSERVABILITY_APP_LOGGER';
export const SECURITY_LOGGER = 'OBSERVABILITY_SECURITY_LOGGER';
export const RETENTION_EXECUTOR = 'OBSERVABILITY_RETENTION_EXECUTOR';
export const LOG_STORAGE = 'OBSERVABILITY_LOG_STORAGE';
export const LOG_WRITER = 'OBSERVABILITY_LOG_WRITER';
export const LOG_QUERY = 'OBSERVABILITY_LOG_QUERY';
