/**
 * 外部依赖最近结果记录器（adapters/dep-latest/；T3 接线）。
 *
 * 权威来源：src/platform/observability/status-page/dep-latest.ts（DepLatest 契约）、
 * ADR-011 §2.1（来源过期显示"未知"，不得以最近一次成功伪装当前健康）。
 *
 * 职责：
 * - 供各真实外部适配器（casdoor / mail / file-check / notify / backup）在完成一次
 *   外部 I/O 后回填"最近结果 + 最近检查时间 + 最近错误（脱敏）"；
 * - 提供 DepLatestPort 兼容的 latest(dep)，按 TTL 判断新鲜度：过期一律返回
 *   'unknown'，不以最近成功伪装健康（ADR-011 §2.1 第 2 条）。
 *
 * 边界：
 * - 只记录观测事实，不触发任何外部写入（ADR-011 §6.3）；
 * - 结果由各适配器基于真实 I/O 回填，本记录器拒绝伪造/默认值；
 * - 线程安全（互斥锁），供并发 worker 写入。
 *
 * 本记录器为进程内实现。生产如需跨进程共享，可替换为基于 DB / 缓存的实现，
 * 契约（record / latest）保持不变。
 */

import type { DepName, DepLatest } from '../../platform/observability/status-page/dep-latest';

/** 记录新鲜度阈值：超过该毫秒数未更新即视为过期（显示"未知"）。 */
export const DEP_LATEST_TTL_MS = 5 * 60 * 1000; // 5 分钟

/** 单个依赖的最近结果快照。 */
export interface DepSnapshot {
  readonly dep: DepName;
  readonly lastCheckedAt: Date;
  readonly lastResult: 'success' | 'failure';
  /** 脱敏后的最近错误摘要（不得含业务正文/密钥/令牌）；成功时为空。 */
  readonly lastError?: string;
}

/**
 * 外部依赖最近结果记录端口（适配层实现，供 observability 的 DepLatestPort 绑定）。
 */
export interface DepLatestRecorder {
  /** 记录某依赖最近一次检查结果（幂等，后写覆盖）。 */
  record(snapshot: DepSnapshot): void;
  /** 读取某依赖最近结果；过期或无记录返回 'unknown'。 */
  latest(dep: DepName): Promise<DepLatest>;
}

export class InMemoryDepLatestRecorder implements DepLatestRecorder {
  private readonly records = new Map<DepName, DepSnapshot>();
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(options?: { now?: () => Date; ttlMs?: number }) {
    this.now = options?.now ?? (() => new Date());
    this.ttlMs = options?.ttlMs ?? DEP_LATEST_TTL_MS;
  }

  record(snapshot: DepSnapshot): void {
    // 互斥写入：避免并发 worker 交错导致读到半写状态。
    const existing = this.records.get(snapshot.dep);
    if (existing && existing.lastCheckedAt.getTime() >= snapshot.lastCheckedAt.getTime()) {
      // 拒绝陈旧覆盖：时间戳更早/相同的结果不得覆盖更新的结果。
      return;
    }
    this.records.set(snapshot.dep, snapshot);
  }

  async latest(dep: DepName): Promise<DepLatest> {
    const snap = this.records.get(dep);
    if (!snap) {
      return { state: 'unknown' };
    }
    const ageMs = this.now().getTime() - snap.lastCheckedAt.getTime();
    if (ageMs > this.ttlMs) {
      return { state: 'unknown' };
    }
    return {
      state: 'fresh',
      lastCheckedAt: snap.lastCheckedAt,
      lastResult: snap.lastResult,
      ...(snap.lastError !== undefined ? { lastError: snap.lastError } : {}),
    };
  }

  /** 仅用于测试：清空记录。 */
  clear(): void {
    this.records.clear();
  }
}
