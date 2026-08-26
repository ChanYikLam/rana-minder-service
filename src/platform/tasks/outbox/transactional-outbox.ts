import type { TaskIntent } from '../contracts';

export const TASK_OUTBOX_STORE = Symbol('TASK_OUTBOX_STORE');

export interface TransactionOutboxStore {
  append(intent: TaskIntent): Promise<void>;
  listPending(limit: number): Promise<readonly TaskIntent[]>;
  markForwarded(intentId: string): Promise<void>;
  /** 转发失败：累加尝试次数，达到上限则置死信（不再参与后续调度）。 */
  markFailed(intentId: string, maxAttempts?: number): Promise<void>;
}
