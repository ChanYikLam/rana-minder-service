/**
 * PostgreSQL 幂等存储（infrastructure；BUG-001 修复）。
 *
 * 表：idempotency_records。以真实持久化替代内存实现，保证跨进程/重启的幂等。
 */

import { Inject, Injectable } from '@nestjs/common';
import type { DbAdapter, TransactionContext } from '../../../shared/db-adapter';
import { DB_ADAPTER } from '../../../adapters/tokens';
import { IdempotencyRecordStatus } from './idempotency-record';
import type { IdempotencyRecord } from './idempotency-record';
import type { IdempotencyStore } from './idempotency-store';

interface IdempotencyRow {
  idempotency_key: string;
  intent_id: string;
  status: string;
  result_ref: string | null;
  updated_at: Date;
}

@Injectable()
export class PostgresIdempotencyStore implements IdempotencyStore {
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

  async find(key: string): Promise<IdempotencyRecord | null> {
    return this.withTx(async (tx) => {
      const rows = await this.db.query<IdempotencyRow>(
        tx,
        `SELECT idempotency_key, intent_id, status, result_ref, updated_at
           FROM public.idempotency_records WHERE idempotency_key = $1`,
        [key],
      );
      if (rows.length === 0) return null;
      return rowToRecord(rows[0]);
    });
  }

  async begin(key: string, intentId: string): Promise<boolean> {
    return this.withTx(async (tx) => {
      const rows = await this.db.query<{ idempotency_key: string }>(
        tx,
        `INSERT INTO public.idempotency_records (idempotency_key, intent_id, status, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING idempotency_key`,
        [key, intentId, IdempotencyRecordStatus.EXECUTING],
      );
      return rows.length > 0;
    });
  }

  async complete(key: string, intentId: string, resultRef: string): Promise<void> {
    await this.withTx(async (tx) => {
      await this.db.query(
        tx,
        `INSERT INTO public.idempotency_records (idempotency_key, intent_id, status, result_ref, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (idempotency_key) DO UPDATE
             SET status = EXCLUDED.status,
                 result_ref = EXCLUDED.result_ref,
                 intent_id = EXCLUDED.intent_id,
                 updated_at = now()`,
        [key, intentId, IdempotencyRecordStatus.COMPLETED, resultRef],
      );
    });
  }

  async fail(key: string, intentId: string): Promise<void> {
    await this.withTx(async (tx) => {
      await this.db.query(
        tx,
        `INSERT INTO public.idempotency_records (idempotency_key, intent_id, status, result_ref, updated_at)
           VALUES ($1, $2, $3, NULL, now())
           ON CONFLICT (idempotency_key) DO UPDATE
             SET status = EXCLUDED.status,
                 result_ref = NULL,
                 intent_id = EXCLUDED.intent_id,
                 updated_at = now()`,
        [key, intentId, IdempotencyRecordStatus.FAILED],
      );
    });
  }
}

function rowToRecord(row: IdempotencyRow): IdempotencyRecord {
  return {
    idempotencyKey: row.idempotency_key,
    intentId: row.intent_id,
    status: row.status as IdempotencyRecord['status'],
    resultRef: row.result_ref,
    updatedAt: row.updated_at.toISOString(),
  };
}
