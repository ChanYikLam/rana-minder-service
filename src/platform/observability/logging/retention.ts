/**
 * 日志保留策略执行器——在线 → 归档 → 清理的周期动作封装。
 *
 * 路径：src/platform/observability/logging/（PR #32 §2.2 B）。
 *
 * 不做策略变更：策略由 domain/services/retention.rules 决定；本类只暴露
 * nextArchiveAt / nextCleanupAt / buildArchiveCommand / buildCleanupCommand。
 *
 * 不依赖具体存储：实际归档/清理由 infrastructure/LogWriterAdapter（7️⃣ 阶段）
 * 实现；本类只产出指令对象，由适配器在收到指令时落 I/O。
 *
 * 时间口径：
 * - `now` 是入参时间，避免执行器内部读系统时间，便于测试固定时钟；
 * - 在线 → 归档切换时间 = now + onlineDays；
 * - 归档到期清理时间 = now + totalDays。
 */

import {
  resolveRetention,
  type LogTier,
  type RetentionPolicy,
} from '../domain/services/retention.rules';

export interface ArchiveCommand {
  readonly tier: LogTier;
  readonly cutoffDate: Date;
  readonly destination: 'archive';
}

export interface CleanupCommand {
  readonly tier: LogTier;
  readonly olderThan: Date;
  readonly destination: 'discard';
}

export interface RetentionExecutor {
  resolve(tier: LogTier): RetentionPolicy;
  nextArchiveAt(tier: LogTier, now: Date): Date;
  nextCleanupAt(tier: LogTier, now: Date): Date;
  buildArchiveCommand(tier: LogTier, now: Date): ArchiveCommand;
  buildCleanupCommand(tier: LogTier, now: Date): CleanupCommand;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class DefaultRetentionExecutor implements RetentionExecutor {
  resolve(tier: LogTier): RetentionPolicy {
    return resolveRetention(tier);
  }

  nextArchiveAt(tier: LogTier, now: Date): Date {
    return new Date(now.getTime() + this.resolve(tier).onlineDays * DAY_MS);
  }

  nextCleanupAt(tier: LogTier, now: Date): Date {
    const policy = this.resolve(tier);
    return new Date(now.getTime() + policy.totalDays * DAY_MS);
  }

  buildArchiveCommand(tier: LogTier, now: Date): ArchiveCommand {
    return {
      tier,
      // 归档指令 = 把在线段切走；具体切多少条由适配器按时间窗筛选。
      cutoffDate: now,
      destination: 'archive',
    };
  }

  buildCleanupCommand(tier: LogTier, now: Date): CleanupCommand {
    const policy = this.resolve(tier);
    return {
      tier,
      // 清理指令 = 把超过 totalDays 的全部清理掉。
      olderThan: new Date(now.getTime() - policy.totalDays * DAY_MS),
      destination: 'discard',
    };
  }
}