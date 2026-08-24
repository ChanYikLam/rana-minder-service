/**
 * 任务积压与最近异常端口。
 *
 * 路径：src/platform/observability/status-page/（PR #32 §2.2 B）。
 *
 * 接口契约：
 * - summarize()：返回 { backlog?, recentFailures }。backlog 可选——任务模块未
 *   暴露 backlog 时返回 undefined，状态页展示端按"未知"渲染；recentFailures
 *   始终返回数组（空数组即"无最近失败"）。
 *
 * 不读业务数据；不调用任务执行/重试；不改任务状态（ADR-011 §2.1 第 1 条）。
 *
 * 首版桩实现 NotWiredTaskSummaryPort：A 的 src/platform/jobs/ 模块未就绪前
 * 返回 { backlog: undefined, recentFailures: [] }——状态页"任务积压"字段
 * 显示"未知"，"最近失败"字段显示"无"。
 */

export interface TaskBacklogSummary {
  readonly byKind: Readonly<Record<string, number>>;
  readonly capturedAt: Date;
}

export interface TaskRecentFailure {
  readonly taskId: string;
  readonly kind: string;
  readonly failedAt: Date;
  readonly message: string;
}

export interface TaskSummarySnapshot {
  readonly backlog?: TaskBacklogSummary;
  readonly recentFailures: readonly TaskRecentFailure[];
}

export interface TaskSummaryPort {
  summarize(): Promise<TaskSummarySnapshot>;
}

export class NotWiredTaskSummaryPort implements TaskSummaryPort {
  async summarize(): Promise<TaskSummarySnapshot> {
    return { recentFailures: [] };
  }
}

/**
 * 任务积压端口（T6）。
 *
 * 委托 platform/tasks 的 TASK_REPOSITORY.backlogSummary() 聚合任务积压
 * （pending/leased/retryableFailed/uncertain/manualIntervention/completed），
 * 映射为状态页的 byKind 视图。只读，不改任务状态（ADR-011 §2.1 第 1 条）。
 */
export interface TaskBacklogLike {
  readonly pending: number;
  readonly leased: number;
  readonly retryableFailed: number;
  readonly uncertain: number;
  readonly manualIntervention: number;
  readonly completed: number;
}

export interface TaskSummaryPortLike {
  backlogSummary(): Promise<TaskBacklogLike>;
}

export class PostgresTaskSummaryPort implements TaskSummaryPort {
  constructor(private readonly repo: TaskSummaryPortLike) {}

  async summarize(): Promise<TaskSummarySnapshot> {
    try {
      const b = await this.repo.backlogSummary();
      return {
        backlog: {
          byKind: {
            pending: b.pending,
            leased: b.leased,
            retryableFailed: b.retryableFailed,
            uncertain: b.uncertain,
            manualIntervention: b.manualIntervention,
            completed: b.completed,
          },
          capturedAt: new Date(),
        },
        recentFailures: [],
      };
    } catch {
      // 积压不可读时按"未知"处理（ADR-011 §2.1 第 2 条），不伪造成功。
      return { recentFailures: [] };
    }
  }
}
