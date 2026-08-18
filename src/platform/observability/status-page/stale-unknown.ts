/**
 * 状态来源过期判定——过期即"未知"（ADR-011 §2.1 第 2 条）。
 *
 * 路径：src/platform/observability/status-page/（PR #32 §2.2 B）。
 *
 * 决策表：
 * - lastCheckedAt 缺失                → state=unknown
 * - 时钟回拨（ageMs < 0）              → state=unknown（保守，避免以过期时间假装新鲜）
 * - ageMs > maxAgeMs                   → state=stale
 * - 否则                              → state=fresh（ageMs 仍可读，用于 UI 排序/提示）
 *
 * 不做：HTTP 注入、配置加载、调用适配器——只接受时间戳与阈值，便于测试固定时钟。
 */

export type StatusSourceState = 'fresh' | 'stale' | 'unknown';

export interface StaleInput {
  readonly lastCheckedAt?: Date;
  readonly maxAgeMs: number;
  readonly now: Date;
}

export interface StaleResult {
  readonly state: StatusSourceState;
  readonly ageMs?: number;
}

export interface StaleUnknownRule {
  evaluate(input: StaleInput): StaleResult;
}

export class DefaultStaleUnknownRule implements StaleUnknownRule {
  evaluate(input: StaleInput): StaleResult {
    if (input.lastCheckedAt === undefined) {
      return { state: 'unknown' };
    }
    const ageMs = input.now.getTime() - input.lastCheckedAt.getTime();
    if (ageMs < 0) {
      return { state: 'unknown' };
    }
    if (ageMs > input.maxAgeMs) {
      return { state: 'stale', ageMs };
    }
    return { state: 'fresh', ageMs };
  }
}
