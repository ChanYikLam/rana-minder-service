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
}
