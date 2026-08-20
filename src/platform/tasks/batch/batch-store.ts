import { Injectable } from '@nestjs/common';
import type { BatchRecord } from '../contracts';

export const BATCH_STORE = Symbol('BATCH_STORE');

export interface BatchStore {
  save(batch: BatchRecord): Promise<void>;
  /**
   * 乐观写：仅当批次当前版本与 expectedVersion 一致时才落盘并递增版本号。
   * 返回是否写入成功（false 表示存在并发修改，需要重新读取合并后重试）。
   */
  saveIfVersion(batch: BatchRecord, expectedVersion: number): Promise<boolean>;
  findById(batchId: string): Promise<BatchRecord | null>;
  findByParentBatchId(parentBatchId: string): Promise<readonly BatchRecord[]>;
}

@Injectable()
export class InMemoryBatchStore implements BatchStore {
  private readonly records = new Map<string, BatchRecord>();

  async save(batch: BatchRecord): Promise<void> {
    this.records.set(batch.batchId, { ...batch, version: batch.version + 1 });
  }

  async saveIfVersion(batch: BatchRecord, expectedVersion: number): Promise<boolean> {
    const current = this.records.get(batch.batchId);
    if ((current?.version ?? 0) !== expectedVersion) return false;
    this.records.set(batch.batchId, { ...batch, version: expectedVersion + 1 });
    return true;
  }

  async findById(batchId: string): Promise<BatchRecord | null> {
    return this.records.get(batchId) ?? null;
  }

  async findByParentBatchId(parentBatchId: string): Promise<readonly BatchRecord[]> {
    return [...this.records.values()].filter((b) => b.parentBatchId === parentBatchId);
  }
}
