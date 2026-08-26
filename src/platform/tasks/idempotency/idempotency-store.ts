import type { IdempotencyRecord } from './idempotency-record';

export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');

export interface IdempotencyStore {
  find(key: string): Promise<IdempotencyRecord | null>;
  /**
   * 标记意图进入执行中；executingUntil 为本次领取租约的到期时刻（ISO），
   * 供崩溃恢复判定任期是否超时（BUG-004）。
   */
  begin(key: string, intentId: string, executingUntil: string): Promise<boolean>;
  complete(key: string, intentId: string, resultRef: string): Promise<void>;
  fail(key: string, intentId: string): Promise<void>;
}
