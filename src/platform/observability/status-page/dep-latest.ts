/**
 * 外部依赖最近结果端口（Casdoor 同步、邮件、文件检查、通知、备份）。
 *
 * 路径：src/platform/observability/status-page/（PR #32 §2.2 B）。
 *
 * 接口契约：
 * - latest(dep)：返回 'unknown' 或带 lastCheckedAt/lastResult/lastError 的
 *   'fresh' 视图。每个 dep 由各自适配器在 src/adapters/ 解锁后实现（DEP-Q-002）。
 *
 * 不调用写命令；不触发外部写入（ADR-011 §6.3）。
 *
 * 首版桩实现 NotWiredDepLatestPort：未连接适配器时一律返回 'unknown'——
 * 状态页对所有 deps 显示"未知"。当前时刻 lastCheckedAt 也返回 'unknown'
 * 之外的 'fresh' 也必须由适配器基于真实 I/O 结果填回；本桩拒绝伪造。
 */

export type DepName = 'casdoor' | 'mail' | 'file-check' | 'notify' | 'backup';

export type DepLatest =
  | { readonly state: 'unknown' }
  | {
      readonly state: 'fresh';
      readonly lastCheckedAt: Date;
      readonly lastResult: 'success' | 'failure';
      readonly lastError?: string;
    };

export interface DepLatestPort {
  latest(dep: DepName): Promise<DepLatest>;
}

export const ALL_DEPS: readonly DepName[] = [
  'casdoor',
  'mail',
  'file-check',
  'notify',
  'backup',
] as const;

export class NotWiredDepLatestPort implements DepLatestPort {
  async latest(_dep: DepName): Promise<DepLatest> {
    return { state: 'unknown' };
  }
}