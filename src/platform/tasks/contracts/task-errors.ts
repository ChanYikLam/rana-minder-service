import type { TaskFailure } from './task-record';

/**
 * 处理器抛出的执行结果信号：由 TaskExecutionPipeline 捕获并据此决定
 * RETRYABLE_FAILED / MANUAL_INTERVENTION，避免非成功结论被吞掉后误标 COMPLETED。
 *
 * - retryable=true  → 走自动退避重试（RETRYABLE_FAILED）；
 * - retryable=false → 立即人工处置（MANUAL_INTERVENTION），不耗尽重试次数。
 */
export class TaskExecutionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly failureKind: TaskFailure['kind'] = 'EXTERNAL_FAILED',
  ) {
    super(message);
    this.name = 'TaskExecutionError';
  }
}