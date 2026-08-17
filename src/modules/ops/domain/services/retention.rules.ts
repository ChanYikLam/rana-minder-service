/**
 * 日志保留期规则——纯领域规则。
 *
 * 覆盖：ADR-011 §2.1、ops/README §6.1。
 *
 * 决策表：日志类别 → 在线天数 + 归档天数 + 总天数。
 *
 * 不管辖：业务审计（AUD-*）——业务审计独立长期保留，与本规则分离
 * （XCC-GEN-007）。本规则只管"运行日志"。
 *
 * 路径迁移：见 src/modules/ops/domain/services/ 同目录其他文件头注释；
 * PR #32 落地时整体迁移。
 */

export type LogTier = 'normal' | 'network' | 'security';

export interface RetentionPolicy {
  readonly onlineDays: number;
  readonly archiveDays: number;
  readonly totalDays: number;
}

// ADR-011 §2.1 候选基线：
// - 普通运行日志：30 天在线 + 60 天压缩归档 = 90 天
// - 网络运行日志：至少 6 个月 = 30 天在线 + 150 天归档 = 180 天
// - 安全事件日志：至少 6 个月 = 30 天在线 + 150 天归档 = 180 天
// 上述数值待首批技术验证后复核锁定，不得视为已冻结。
export const DEFAULT_RETENTION_POLICIES: Readonly<Record<LogTier, RetentionPolicy>> = {
  normal: { onlineDays: 30, archiveDays: 60, totalDays: 90 },
  network: { onlineDays: 30, archiveDays: 150, totalDays: 180 },
  security: { onlineDays: 30, archiveDays: 150, totalDays: 180 },
};

export function resolveRetention(tier: LogTier | string): RetentionPolicy {
  if (tier === 'normal' || tier === 'network' || tier === 'security') {
    return DEFAULT_RETENTION_POLICIES[tier];
  }
  // 未知类别一律按"normal"处理；具体分类错误由 LogWriterAdapter 上报。
  return DEFAULT_RETENTION_POLICIES.normal;
}

export function isLogTier(value: string): value is LogTier {
  return value === 'normal' || value === 'network' || value === 'security';
}