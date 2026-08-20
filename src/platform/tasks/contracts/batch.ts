import type { TaskScope } from './task-scope';

export const BatchStatus = {
  SELECTING: 'SELECTING',
  PREVIEWED: 'PREVIEWED',
  EXECUTING: 'EXECUTING',
  ALL_SUCCEEDED: 'ALL_SUCCEEDED',
  PARTIALLY_SUCCEEDED: 'PARTIALLY_SUCCEEDED',
  ALL_FAILED: 'ALL_FAILED',
  RETRYING_FAILED: 'RETRYING_FAILED',
} as const;

export type BatchStatus = (typeof BatchStatus)[keyof typeof BatchStatus];

export const BatchItemStatus = {
  PENDING: 'PENDING',
  EXECUTING: 'EXECUTING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  REJECTED: 'REJECTED',
} as const;

export type BatchItemStatus = (typeof BatchItemStatus)[keyof typeof BatchItemStatus];

export interface BatchItemInput<T = unknown> {
  readonly itemId: string;
  readonly version: number;
  readonly input: T;
  readonly idempotencyKey: string;
}

export interface BatchPreview<T = unknown> {
  readonly batchId: string;
  readonly previewVersion: number;
  readonly scope: TaskScope;
  readonly operationType: string;
  readonly businessType: string;
  readonly items: readonly BatchItemInput<T>[];
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface BatchItemResult {
  readonly itemId: string;
  readonly status: BatchItemStatus;
  readonly reason?: string;
  readonly resultRef?: string;
}

export interface BatchRecord {
  readonly batchId: string;
  readonly parentBatchId?: string;
  readonly previewVersion: number;
  readonly version: number;
  readonly scope: TaskScope;
  readonly operationType: string;
  readonly businessType: string;
  readonly status: BatchStatus;
  readonly frozenItems: readonly BatchItemInput[];
  readonly itemResults: readonly BatchItemResult[];
  readonly createdAt: string;
  readonly confirmedAt?: string;
  readonly completedAt?: string;
}

export interface BatchSummary {
  readonly batchId: string;
  readonly status: BatchStatus;
  readonly succeeded: number;
  readonly failed: number;
  readonly rejected: number;
  readonly total: number;
}
