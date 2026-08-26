export const IdempotencyRecordStatus = {
  EXECUTING: 'EXECUTING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

export type IdempotencyRecordStatus =
  (typeof IdempotencyRecordStatus)[keyof typeof IdempotencyRecordStatus];

export interface IdempotencyRecord {
  readonly idempotencyKey: string;
  readonly intentId: string;
  readonly status: IdempotencyRecordStatus;
  readonly resultRef: string | null;
  readonly updatedAt: string;
  /**
   * 进入 EXECUTING 时记录的任期到期时刻（ISO）。用于崩溃恢复判定：
   * 区别于任务表"当前行"租约——重领后会刷新为新租约，若据此判断会永远未过期
   * 导致恢复重放不可达（BUG-004）。恢复分支据此判断"记录声明执行中的任期是否已超时"。
   */
  readonly executingUntil?: string | null;
}
