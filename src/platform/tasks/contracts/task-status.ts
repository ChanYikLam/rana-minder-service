export const TaskStatus = {
  PENDING: 'PENDING',
  LEASED: 'LEASED',
  RETRYABLE_FAILED: 'RETRYABLE_FAILED',
  UNCERTAIN: 'UNCERTAIN',
  MANUAL_INTERVENTION: 'MANUAL_INTERVENTION',
  COMPLETED: 'COMPLETED',
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const TASK_STATUS_SEMANTICS: Readonly<Record<TaskStatus, string>> = {
  [TaskStatus.PENDING]: '待执行：任务意图已可靠持久化，等待调度器领取。',
  [TaskStatus.LEASED]: '执行中：执行器已通过租约竞争取得执行权，租约未过期。',
  [TaskStatus.RETRYABLE_FAILED]: '可重试失败：执行失败且仍可自动按退避策略重试。',
  [TaskStatus.UNCERTAIN]: '结果不确定，需读回：外部结果无法确认，必须先可信回读/查询再收口。',
  [TaskStatus.MANUAL_INTERVENTION]:
    '不可自动重试/需人工处置：重试上限已用尽或前置条件要求人工介入。',
  [TaskStatus.COMPLETED]: '已完成：业务结果已可信收口，任务不可再执行。',
} as const;

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  TaskStatus.COMPLETED,
]);

export const RUNNABLE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  TaskStatus.PENDING,
  TaskStatus.RETRYABLE_FAILED,
]);

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

export function isRunnableTaskStatus(status: TaskStatus): boolean {
  return RUNNABLE_TASK_STATUSES.has(status);
}
