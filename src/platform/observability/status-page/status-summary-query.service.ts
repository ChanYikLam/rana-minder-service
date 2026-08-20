/**
 * 状态汇总查询用例——聚合各端口最近结果 + 过期判定（ADR-011 §2.1 第 2 条）。
 *
 * 路径：src/platform/observability/status-page/（PR #32 §2.2 B）。
 *
 * 不查询业务数据；不调用任何写命令；不触发外部写入或任务重试（ADR-011 §6.3）。
 *
 * 输出：StatusSummaryView。每个来源（db / task / 各 dep）都带 state + ageMs +
 * data；来源过期时 state='unknown'。状态来源缺失（lastCheckedAt 缺失）→ unknown；
 * 时钟回拨 → unknown（保守，避免以过期时间假装新鲜）。
 *
 * 时间口径：now 由调用方传入，便于测试固定时钟。
 */

import {
  DefaultStaleUnknownRule,
  type StaleUnknownRule,
  type StatusSourceState,
} from './stale-unknown';
import { type AppStatusPort, type AppStatusSnapshot } from './app-status';
import { type DbStatusPort, type DbPingResult } from './db-status';
import { type TaskSummaryPort, type TaskSummarySnapshot } from './task-summary';
import { type DepLatestPort, type DepLatest, type DepName, ALL_DEPS } from './dep-latest';

export interface StatusSourceView<T> {
  readonly state: StatusSourceState;
  readonly ageMs?: number;
  readonly data?: T;
}

export interface StatusSummaryView {
  readonly now: Date;
  readonly app: AppStatusSnapshot;
  readonly db: StatusSourceView<DbPingResult>;
  readonly task: StatusSourceView<TaskSummarySnapshot>;
  readonly deps: Readonly<Record<DepName, StatusSourceView<DepLatest>>>;
}

export interface StatusSummaryQueryOptions {
  readonly staleMs?: {
    readonly db?: number;
    readonly dep?: number;
    readonly task?: number;
  };
}

export interface StatusSummaryQueryService {
  execute(now: Date, options?: StatusSummaryQueryOptions): Promise<StatusSummaryView>;
}

const DEFAULT_DB_STALE_MS = 30_000;
const DEFAULT_DEP_STALE_MS = 5 * 60_000;
const DEFAULT_TASK_STALE_MS = 60_000;

export class DefaultStatusSummaryQueryService implements StatusSummaryQueryService {
  constructor(
    private readonly app: AppStatusPort,
    private readonly db: DbStatusPort,
    private readonly task: TaskSummaryPort,
    private readonly dep: DepLatestPort,
    private readonly rule: StaleUnknownRule = new DefaultStaleUnknownRule(),
  ) {}

  async execute(now: Date, options: StatusSummaryQueryOptions = {}): Promise<StatusSummaryView> {
    const dbStale = options.staleMs?.db ?? DEFAULT_DB_STALE_MS;
    const depStale = options.staleMs?.dep ?? DEFAULT_DEP_STALE_MS;
    const taskStale = options.staleMs?.task ?? DEFAULT_TASK_STALE_MS;

    const dbPing = await this.db.ping();
    const dbView: StatusSourceView<DbPingResult> = dbPing.ok
      ? {
          state: this.rule.evaluate({ lastCheckedAt: now, maxAgeMs: dbStale, now }).state,
          ageMs: this.rule.evaluate({ lastCheckedAt: now, maxAgeMs: dbStale, now }).ageMs,
          data: dbPing,
        }
      : { state: 'unknown', data: dbPing };

    const taskSnap = await this.task.summarize();
    const taskEval = this.rule.evaluate({ lastCheckedAt: now, maxAgeMs: taskStale, now });
    const taskView: StatusSourceView<TaskSummarySnapshot> = {
      state: taskEval.state,
      ageMs: taskEval.ageMs,
      data: taskSnap,
    };

    const depViews = {} as Record<DepName, StatusSourceView<DepLatest>>;
    for (const dep of ALL_DEPS) {
      const latest = await this.dep.latest(dep);
      const view: StatusSourceView<DepLatest> =
        latest.state === 'unknown'
          ? { state: 'unknown', data: latest }
          : (() => {
              const r = this.rule.evaluate({
                lastCheckedAt: latest.lastCheckedAt,
                maxAgeMs: depStale,
                now,
              });
              return { state: r.state, ageMs: r.ageMs, data: latest };
            })();
      depViews[dep] = view;
    }

    return {
      now,
      app: this.app.snapshot(now),
      db: dbView,
      task: taskView,
      deps: depViews,
    };
  }
}
