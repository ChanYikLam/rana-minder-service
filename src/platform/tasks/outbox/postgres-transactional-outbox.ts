/**
 * PostgreSQL 事务发件箱存储（infrastructure；BUG-001 修复）。
 *
 * 表：task_outbox（与迁移 20260824120000_create-task-infra-tables 逐列对齐）。
 * 以真实持久化替代内存实现，避免进程重启丢失意图、跨 worker 去重失效。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DbAdapter, TransactionContext } from '../../../shared/db-adapter';
import { DB_ADAPTER } from '../../../adapters/tokens';
import type { TaskIntent } from '../contracts';
import type { TransactionOutboxStore } from './transactional-outbox';

interface OutboxRow {
  intent_id: string;
  task_type: string;
  idempotency_key: string;
  scope: unknown;
  source: unknown;
  payload: unknown;
  not_before: Date;
  status: string;
  attempts: string;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `intent_id, task_type, idempotency_key, scope, source, payload, not_before, status, attempts, created_at, updated_at`;

@Injectable()
export class PostgresTransactionOutboxStore implements TransactionOutboxStore {
  private readonly logger = new Logger(PostgresTransactionOutboxStore.name);

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

  async append(intent: TaskIntent): Promise<void> {
    await this.withTx(async (tx) => {
      await this.db.query(
        tx,
        `INSERT INTO public.task_outbox
              (intent_id, task_type, idempotency_key, scope, source, payload, not_before, status, attempts, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',0,$8,$8)
          ON CONFLICT (intent_id) DO NOTHING`,
        [
          intent.intentId,
          intent.taskType,
          intent.idempotencyKey,
          JSON.stringify(intent.scope),
          JSON.stringify(intent.source),
          JSON.stringify(intent.payload),
          intent.notBefore,
          intent.createdAt,
        ],
      );
    });
  }

  async listPending(limit: number): Promise<readonly TaskIntent[]> {
    return this.withTx(async (tx) => {
      const rows = await this.db.query<OutboxRow>(
        tx,
        `SELECT ${COLUMNS} FROM public.task_outbox
           WHERE status = 'PENDING'
           ORDER BY created_at ASC
           LIMIT $1`,
        [limit],
      );
      return rows.map(rowToIntent);
    });
  }

  async markForwarded(intentId: string): Promise<void> {
    await this.withTx(async (tx) => {
      await this.db.query(
        tx,
        `UPDATE public.task_outbox SET status = 'FORWARDED', updated_at = now()
           WHERE intent_id = $1`,
        [intentId],
      );
    });
  }

  async markFailed(intentId: string, maxAttempts = 5): Promise<void> {
    await this.withTx(async (tx) => {
      await this.db.query(
        tx,
        `UPDATE public.task_outbox
            SET attempts = attempts + 1,
                status = CASE WHEN attempts + 1 >= $2 THEN 'DEAD' ELSE status END,
                updated_at = now()
          WHERE intent_id = $1 AND status = 'PENDING'`,
        [intentId, maxAttempts],
      );
    });
  }
}

function rowToIntent(row: OutboxRow): TaskIntent {
  return {
    intentId: row.intent_id,
    taskType: row.task_type as TaskIntent['taskType'],
    idempotencyKey: row.idempotency_key,
    scope: row.scope as TaskIntent['scope'],
    source: row.source as TaskIntent['source'],
    payload: row.payload,
    notBefore: row.not_before.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}
