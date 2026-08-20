import { Injectable } from '@nestjs/common';
import type { IdempotencyRecord } from './idempotency-record';
import type { IdempotencyStore } from './idempotency-store';

@Injectable()
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  async find(key: string): Promise<IdempotencyRecord | null> {
    return this.records.get(key) ?? null;
  }

  async begin(key: string, intentId: string): Promise<boolean> {
    if (this.records.has(key)) return false;
    this.records.set(key, {
      idempotencyKey: key,
      intentId,
      status: 'EXECUTING',
      resultRef: null,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  async complete(key: string, intentId: string, resultRef: string): Promise<void> {
    this.records.set(key, {
      idempotencyKey: key,
      intentId,
      status: 'COMPLETED',
      resultRef,
      updatedAt: new Date().toISOString(),
    });
  }

  async fail(key: string, intentId: string): Promise<void> {
    this.records.set(key, {
      idempotencyKey: key,
      intentId,
      status: 'FAILED',
      resultRef: null,
      updatedAt: new Date().toISOString(),
    });
  }
}
