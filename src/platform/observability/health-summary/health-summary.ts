/**
 * 子系统健康汇总——对内判定服务（ADR-011 §6.3）。
 *
 * 路径：src/platform/observability/health-summary/（PR #32 §2.2 B）。
 *
 * 定位：
 * - **对内**判定服务：被其它模块消费（例：调度器在"备份子系统 24h+ 失败"时
 *   暂缓某些后台任务）；**不暴露 HTTP 端点**；
 * - **不替代**机器健康监测（ADR-011 §6.3 显式禁止：不得推导 livenessProbe
 *   /readinessProbe /指标导出端点/外部告警 Webhook）；
 * - **不读业务数据**；**不调用**任何写命令、触发任务重试或外部写入。
 *
 * 数据来源：本服务消费 StatusSummaryQueryService 的输出（view 层），不在
 * 此处再次聚合下层端口——保证状态汇总的"事实唯一来源"是状态汇总查询用例，
 * 本服务只做"事实 → 判定"的纯映射。
 *
 * 判定规则（缺省）：
 * - 任一 subsystem.state = 'stale' 或 'unknown' → overall='degraded'
 * - 全 fresh → overall='ok'
 * - 空集 / 全 unknown → overall='unknown'
 *
 * 不做：阈值自适应、机器学习、外部判定参考。
 */

import { type StatusSummaryQueryService } from '../status-page/status-summary-query.service';

export type SubsystemName =
  'app' | 'db' | 'task' | 'casdoor' | 'mail' | 'file-check' | 'notify' | 'backup';

export type HealthVerdict = 'ok' | 'degraded' | 'unknown';

export interface SubsystemHealth {
  readonly name: SubsystemName;
  readonly state: 'fresh' | 'stale' | 'unknown';
  readonly ageMs?: number;
}

export interface HealthSummary {
  readonly now: Date;
  readonly overall: HealthVerdict;
  readonly subsystems: readonly SubsystemHealth[];
}

export interface HealthSummaryService {
  execute(now: Date): Promise<HealthSummary>;
}

export class DefaultHealthSummaryService implements HealthSummaryService {
  constructor(private readonly query: StatusSummaryQueryService) {}

  async execute(now: Date): Promise<HealthSummary> {
    const view = await this.query.execute(now);

    const subsystems: SubsystemHealth[] = [
      { name: 'app', state: 'fresh' }, // 应用进程本身：snapshot 必有 → fresh
      {
        name: 'db',
        state: view.db.state,
        ...(view.db.ageMs !== undefined ? { ageMs: view.db.ageMs } : {}),
      },
      {
        name: 'task',
        state: view.task.state,
        ...(view.task.ageMs !== undefined ? { ageMs: view.task.ageMs } : {}),
      },
      ...(['casdoor', 'mail', 'file-check', 'notify', 'backup'] as const).map((dep) => {
        const d = view.deps[dep];
        return { name: dep, state: d.state, ...(d.ageMs !== undefined ? { ageMs: d.ageMs } : {}) };
      }),
    ];

    let overall: HealthVerdict;
    const allUnknown = subsystems.every((s) => s.state === 'unknown');
    const anyDegraded = subsystems.some((s) => s.state === 'stale' || s.state === 'unknown');
    if (allUnknown) {
      overall = 'unknown';
    } else if (anyDegraded) {
      overall = 'degraded';
    } else {
      overall = 'ok';
    }

    return { now, overall, subsystems };
  }
}
