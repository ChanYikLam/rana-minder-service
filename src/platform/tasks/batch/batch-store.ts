import { Injectable } from '@nestjs/common';
import type { BatchRecord } from '../contracts';

export const BATCH_STORE = Symbol('BATCH_STORE');

export interface BatchStore {
  save(batch: BatchRecord): Promise<void>;
  findById(batchId: string): Promise<BatchRecord | null>;
  findByParentBatchId(parentBatchId: string): Promise<readonly BatchRecord[]>;
}

@Injectable()
export class InMemoryBatchStore implements BatchStore {
  private readonly records = new Map<string, BatchRecord>();

  async save(batch: BatchRecord): Promise<void> {
    this.records.set(batch.batchId, batch);
  }

  async findById(batchId: string): Promise<BatchRecord | null> {
    return this.records.get(batchId) ?? null;
  }

  async findByParentBatchId(parentBatchId: string): Promise<readonly BatchRecord[]> {
    return [...this.records.values()].filter((b) => b.parentBatchId === parentBatchId);
  }
}
