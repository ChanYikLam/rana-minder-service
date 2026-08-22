/**
 * 外部依赖最近结果端口 · 记录器桥接实现（observability/status-page/；T3 接线）。
 *
 * 职责：把 adapters 模块的 DepLatestRecorder（各真实外部适配器回填的最近结果）
 * 桥接为 observability 状态页的 DepLatestPort 契约（ADR-011 §2.1：过期显示"未知"）。
 *
 * 边界：
 * - 只读：不触发外部写入、不查询业务数据（ADR-011 §6.3）；
 * - 桩（未启用真实适配器）时记录器无数据 → 返回 unknown，状态页显示"未知"，
 *   不伪造健康。
 */

import type { DepLatest, DepLatestPort, DepName } from './dep-latest';
import type { DepLatestRecorder } from '../../../adapters/dep-latest/dep-latest-recorder';

export class RecorderDepLatestPort implements DepLatestPort {
  constructor(private readonly recorder: DepLatestRecorder) {}

  async latest(dep: DepName): Promise<DepLatest> {
    return this.recorder.latest(dep);
  }
}
