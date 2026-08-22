/**
 * 平台适配边界 DI 标识符（adapters 模块，@Global）。
 *
 * 字符串标识符约定同 src/config/tokens.ts（避免 Symbol 序列化与跨进程比较歧义）。
 * 真实实现在 DEP-Q-001/002（依赖与版本基线首批技术验证）锁定后替换 NotWired 桩；
 * 依赖可用性开关见 adapters.module.ts（fail-closed，默认关闭）。
 */

export const DB_ADAPTER = 'ADAPTERS_DB';
export const CASDOOR_ADAPTER = 'ADAPTERS_CASDOOR';
export const MAIL_CHANNEL_ADAPTER = 'ADAPTERS_MAIL';
/** 文件检查外部服务适配（FileCheckPort 真实实现，fail-closed 默认关闭）。 */
export const ADAPTERS_FILECHECK = 'ADAPTERS_FILECHECK';
/** 外部通知渠道适配（NotifyAdapter 真实实现，fail-closed 默认关闭）。 */
export const ADAPTERS_NOTIFY = 'ADAPTERS_NOTIFY';
/** 备份报告外部适配（BackupReportPort 真实实现，fail-closed 默认关闭）。 */
export const ADAPTERS_BACKUP = 'ADAPTERS_BACKUP';
/** 外部依赖最近结果记录器（供 observability 的 DepLatestPort 绑定）。 */
export const DEP_LATEST_RECORDER = 'ADAPTERS_DEP_LATEST_RECORDER';
