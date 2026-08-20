import type { TaskRecord, TaskRecordPatch } from './task-record';
import type { TaskIntent } from './task-intent';
import type { TaskType } from './task-type';

export const TASK_REPOSITORY = Symbol('TASK_REPOSITORY');
export const TASK_PROCESSOR_REGISTRY = Symbol('TASK_PROCESSOR_REGISTRY');
export const TASK_OPS_TELEMETRY_PORT = Symbol('TASK_OPS_TELEMETRY_PORT');

export const TaskOpsEventType = {
  TASK_BACKLOG: 'TASK_BACKLOG',
  TASK_EXECUTION_FAILED: 'TASK_EXECUTION_FAILED',
  TASK_LEASE_RECOVERED: 'TASK_LEASE_RECOVERED',
  TASK_MANUAL_INTERVENTION_REQUIRED: 'TASK_MANUAL_INTERVENTION_REQUIRED',
} as const;

export type TaskOpsEventType = (typeof TaskOpsEventType)[keyof typeof TaskOpsEventType];

export interface TaskOpsEvidence {
  readonly event: TaskOpsEventType;
  readonly ref: string;
  readonly reason: string;
  readonly occurredAt: string;
}

export interface TaskOpsTelemetryPort {
  report(evidence: TaskOpsEvidence): Promise<void>;
}

export interface TaskClaimResult {
  readonly claimed: boolean;
  readonly task: TaskRecord | null;
  readonly reason?: 'NOT_FOUND' | 'LEASE_BUSY' | 'NOT_DUE' | 'TERMINAL' | 'LEASE_EXPIRED_RECOVERED';
}

export interface TaskRepository {
  insert(intent: TaskIntent): Promise<TaskRecord>;
  findById(taskId: string): Promise<TaskRecord | null>;
  findByIntentId(intentId: string): Promise<TaskRecord | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<TaskRecord | null>;
  tryClaim(
    taskId: string,
    workerId: string,
    leaseUntil: string,
    leaseVersion: number,
    now: Date,
  ): Promise<TaskClaimResult>;
  updateAfterExecution(
    taskId: string,
    expectedLeaseVersion: number,
    patch: TaskRecordPatch,
  ): Promise<TaskRecord | null>;
  listDueTaskIds(now: string, limit: number): Promise<readonly string[]>;
  listDeadlineTaskIds(before: string, limit: number): Promise<readonly string[]>;
  listExpiredLeaseTaskIds(now: string, limit: number): Promise<readonly string[]>;
  backlogSummary(): Promise<TaskBacklogSummary>;
}

export interface TaskBacklogSummary {
  readonly pending: number;
  readonly leased: number;
  readonly retryableFailed: number;
  readonly uncertain: number;
  readonly manualIntervention: number;
  readonly completed: number;
  readonly perType: Readonly<Record<TaskType, number>>;
}

export interface TaskHandler<T = unknown> {
  readonly taskType: TaskType;
  handle(task: TaskRecord<T>, now?: Date): Promise<void>;
}

export interface TaskProcessorRegistry {
  register(handler: TaskHandler): void;
  get(taskType: TaskType): TaskHandler | undefined;
  list(): readonly TaskHandler[];
}
