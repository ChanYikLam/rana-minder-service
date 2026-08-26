/**
 * PostgreSQL 批次存储（infrastructure；BUG-001 修复）。
 *
 * 表：batch_records。以真实持久化替代内存实现，保证批次状态跨进程一致。
 * 语义与 InMemoryBatchStore 对齐：save 在冲突时按输入版本 +1 递增（非乐观）；
 * saveIfVersion 执行乐观写（仅当当前版本 == expectedVersion）。
 * 注意：save 的 INSERT VALUES 已把 version 写成 $4 = batch.version + 1，故
 * ON CONFLICT DO UPDATE 直接采用 EXCLUDED.version（=输入版本+1），不再二次自增，
 * 避免版本号跳 2（历史缺陷：version = EXCLUDED.version + 1 导致 +2，破坏乐观并发校验）。
 */

import { Inject, Injectable } from '@nestjs/common';
import type { DbAdapter, TransactionContext } from '../../../shared/db-adapter';
import { DB_ADAPTER } from '../../../adapters/tokens';
import type { BatchRecord } from '../contracts';
import type { BatchStore } from './batch-store';

interface BatchRow {
  batch_id: string;
  parent_batch_id: string | null;
  preview_version: string;
  version: string;
  status: string;
  scope: unknown;
  operation_type: string;
  business_type: string;
  frozen_items: unknown;
  item_results: unknown;
  created_at: Date;
  confirmed_at: Date | null;
  completed_at: Date | null;
}

const COLUMNS = `batch_id, parent_batch_id, preview_version, version, status, scope, operation_type, business_type, frozen_items, item_results, created_at, confirmed_at, completed_at`;

@Injectable()
export class PostgresBatchStore implements BatchStore {
  constructor(@Inject(DB_ADAPTER) private readonly db: DbAdapter) {}

  private async withTx<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const tx = await this.db.beginTransaction();
    try {
      await this.db.setRlsContext(tx, { kind: 'unprotected' });
      const result = await fn(tx);
      await this.db.commit(tx);
      return result;
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }

  async save(batch: BatchRecord): Promise<void> {
    await this.withTx(async (tx) => {
      await this.db.query(
        tx,
        `INSERT INTO public.batch_records
              (batch_id, parent_batch_id, preview_version, version, status, scope, operation_type, business_type, frozen_items, item_results, created_at, confirmed_at, completed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (batch_id) DO UPDATE SET
              version = EXCLUDED.version,
              preview_version = EXCLUDED.preview_version,
              status = EXCLUDED.status,
              scope = EXCLUDED.scope,
              operation_type = EXCLUDED.operation_type,
              business_type = EXCLUDED.business_type,
              frozen_items = EXCLUDED.frozen_items,
              item_results = EXCLUDED.item_results,
              confirmed_at = EXCLUDED.confirmed_at,
              completed_at = EXCLUDED.completed_at`,
        [
          batch.batchId,
          batch.parentBatchId ?? null,
          batch.previewVersion,
          batch.version + 1,
          batch.status,
          JSON.stringify(batch.scope),
          batch.operationType,
          batch.businessType,
          JSON.stringify(batch.frozenItems),
          JSON.stringify(batch.itemResults),
          batch.createdAt,
          batch.confirmedAt ?? null,
          batch.completedAt ?? null,
        ],
      );
    });
  }

  async saveIfVersion(batch: BatchRecord, expectedVersion: number): Promise<boolean> {
    return this.withTx(async (tx) => {
      const rows = await this.db.query<{ batch_id: string }>(
        tx,
        `UPDATE public.batch_records SET
              version = $2 + 1,
              preview_version = $3,
              status = $4,
              scope = $5,
              operation_type = $6,
              business_type = $7,
              frozen_items = $8,
              item_results = $9,
              confirmed_at = $10,
              completed_at = $11
          WHERE batch_id = $1 AND version = $2
          RETURNING batch_id`,
        [
          batch.batchId,
          expectedVersion,
          batch.previewVersion,
          batch.status,
          JSON.stringify(batch.scope),
          batch.operationType,
          batch.businessType,
          JSON.stringify(batch.frozenItems),
          JSON.stringify(batch.itemResults),
          batch.confirmedAt ?? null,
          batch.completedAt ?? null,
        ],
      );
      return rows.length > 0;
    });
  }

  async findById(batchId: string): Promise<BatchRecord | null> {
    return this.withTx(async (tx) => {
      const rows = await this.db.query<BatchRow>(
        tx,
        `SELECT ${COLUMNS} FROM public.batch_records WHERE batch_id = $1`,
        [batchId],
      );
      return rows.length > 0 ? rowToRecord(rows[0]) : null;
    });
  }

  async findByParentBatchId(parentBatchId: string): Promise<readonly BatchRecord[]> {
    return this.withTx(async (tx) => {
      const rows = await this.db.query<BatchRow>(
        tx,
        `SELECT ${COLUMNS} FROM public.batch_records WHERE parent_batch_id = $1`,
        [parentBatchId],
      );
      return rows.map(rowToRecord);
    });
  }
}

function rowToRecord(row: BatchRow): BatchRecord {
  return {
    batchId: row.batch_id,
    parentBatchId: row.parent_batch_id ?? undefined,
    previewVersion: Number(row.preview_version),
    version: Number(row.version),
    status: row.status as BatchRecord['status'],
    scope: row.scope as BatchRecord['scope'],
    operationType: row.operation_type as BatchRecord['operationType'],
    businessType: row.business_type as BatchRecord['businessType'],
    frozenItems: (row.frozen_items as BatchRecord['frozenItems']) ?? [],
    itemResults: (row.item_results as BatchRecord['itemResults']) ?? [],
    createdAt: row.created_at.toISOString(),
    confirmedAt: row.confirmed_at ? row.confirmed_at.toISOString() : undefined,
    completedAt: row.completed_at ? row.completed_at.toISOString() : undefined,
  };
}
