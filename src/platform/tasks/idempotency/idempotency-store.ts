import type { IdempotencyRecord } from './idempotency-record';

export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');

export interface IdempotencyStore {
  find(key: string): Promise<IdempotencyRecord | null>;
  begin(key: string, intentId: string): Promise<boolean>;
  complete(key: string, intentId: string, resultRef: string): Promise<void>;
  fail(key: string, intentId: string): Promise<void>;
}
