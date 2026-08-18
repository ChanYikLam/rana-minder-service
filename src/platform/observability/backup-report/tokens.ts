/**
 * observability/backup-report 子模块的 DI 标识符。
 *
 * 字符串标识符约定同 src/config/tokens.ts。
 *
 * 本子模块是**只读**备份/恢复最近事件视图，**不替代**备份系统、备份完成证明
 * 或任务执行权威（ADR-011 §6.3 / observability/README §3 明文禁止）。
 */

export const BACKUP_REPORT_PORT = 'OBSERVABILITY_BACKUP_REPORT_PORT';
export const BACKUP_REPORT_SERVICE = 'OBSERVABILITY_BACKUP_REPORT_SERVICE';
