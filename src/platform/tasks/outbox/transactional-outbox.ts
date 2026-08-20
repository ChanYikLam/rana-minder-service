import type { TaskIntent } from '../contracts';

export const TASK_OUTBOX_STORE = Symbol('TASK_OUTBOX_STORE');

export interface TransactionOutboxStore {
  append(intent: TaskIntent): Promise<void>;
  listPending(limit: number): Promise<readonly TaskIntent[]>;
  markForwarded(intentId: string): Promise<void>;
}
