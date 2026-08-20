import type { TaskScope } from './task-scope';
import type { TaskSourceRef } from './task-source';
import type { TaskType } from './task-type';

export interface TaskIntent<T = unknown> {
  readonly intentId: string;
  readonly taskType: TaskType;
  readonly idempotencyKey: string;
  readonly scope: TaskScope;
  readonly source: TaskSourceRef;
  readonly payload: T;
  readonly notBefore: string;
  readonly createdAt: string;
}

export function deriveTrackingNumber(intentId: string, taskType: string): string {
  return `task:${taskType}:${intentId}`;
}
