import type { TaskScope } from './task-scope';
import type { TaskSourceRef } from './task-source';
import type { TaskStatus } from './task-status';
import type { TaskType } from './task-type';

export interface TaskLease {
  readonly workerId: string;
  readonly leaseVersion: number;
  readonly leaseUntil: string;
  readonly leasedAt: string;
}

export interface TaskFailure {
  readonly kind:
    | 'PRECONDITION_REJECTED'
    | 'VERSION_STALE'
    | 'PERMISSION_DENIED'
    | 'EXTERNAL_FAILED'
    | 'EXTERNAL_UNCERTAIN'
    | 'LEASE_EXPIRED'
    | 'RETRY_LIMIT_EXCEEDED'
    | 'MANUAL_INTERVENTION_REQUIRED';
  readonly reason: string;
  readonly occurredAt: string;
}

export interface TaskRecord<T = unknown> {
  readonly taskId: string;
  readonly taskType: TaskType;
  readonly status: TaskStatus;
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly scope: TaskScope;
  readonly source: TaskSourceRef;
  readonly payload: T;
  readonly lease: TaskLease | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly notBefore: string;
  readonly failure: TaskFailure | null;
  readonly resultRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TaskRecordPatch = Partial<
  Pick<
    TaskRecord,
    'status' | 'lease' | 'attempts' | 'failure' | 'resultRef' | 'updatedAt' | 'notBefore'
  >
>;
