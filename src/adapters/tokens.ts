/**
 * 平台适配边界 DI 标识符（adapters 模块，@Global）。
 *
 * 字符串标识符约定同 src/config/tokens.ts（避免 Symbol 序列化与跨进程比较歧义）。
 * 实现在 DEP-Q-001/002（依赖与版本基线首批技术验证）锁定后替换 NotWired 桩。
 */

export const DB_ADAPTER = 'ADAPTERS_DB';
export const CASDOOR_ADAPTER = 'ADAPTERS_CASDOOR';
export const MAIL_CHANNEL_ADAPTER = 'ADAPTERS_MAIL';
