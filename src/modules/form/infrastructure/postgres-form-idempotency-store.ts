/**
 * PostgreSQL 表单设计幂等存储（infrastructure；IFC-GEN-006 落地）。
 *
 * 表 form_idempotency（PK scope_key + idempotency_key，语义摘要比对）：
 * - claim：INSERT ... ON CONFLICT DO NOTHING；新占位返回 inserted=true；
 *   既有记录返回 inserted=false 并带既有摘要（用例比对同/异摘要）；
 * - complete：UPDATE ... WHERE 摘要匹配，回填 jsonb 结果；
 * - readResult：读回填结果（null = 仍在处理中，IFC-ERR-014）。
 */

import type { DbAdapter } from '../../../shared/db-adapter';
import type { FormUnitOfWork } from './unit-of-work';
import type {
  FormIdempotencyStore,
  FormIdempotencyClaim,
  FormIdempotencyClaimOutcome,
  FormIdempotencyCompletion,
} from '../application/ports/form-idempotency-store.port';

interface IdempotencyRow {
  scope_key: string;
  idempotency_key: string;
  semantic_hash: string;
  result: unknown;
}

export class PostgresFormIdempotencyStore implements FormIdempotencyStore {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: FormUnitOfWork,
  ) {}

  async claim(input: FormIdempotencyClaim): Promise<FormIdempotencyClaimOutcome> {
    const inserted = await this.db.query<{ scope_key: string }>(
      this.uow.active,
      `INSERT INTO form_idempotency (scope_key, idempotency_key, semantic_hash, result)
       VALUES ($1, $2, $3, NULL)
       ON CONFLICT (scope_key, idempotency_key) DO NOTHING
       RETURNING scope_key`,
      [input.scopeKey, input.idempotencyKey, input.semanticHash],
    );
    if (inserted.length > 0) {
      return { inserted: true, existingHash: null };
    }
    const rows = await this.db.query<IdempotencyRow>(
      this.uow.active,
      `SELECT scope_key, idempotency_key, semantic_hash, result
         FROM form_idempotency
        WHERE scope_key = $1 AND idempotency_key = $2`,
      [input.scopeKey, input.idempotencyKey],
    );
    return { inserted: false, existingHash: rows[0]?.semantic_hash ?? null };
  }

  async complete(input: FormIdempotencyCompletion): Promise<void> {
    await this.db.query(
      this.uow.active,
      `UPDATE form_idempotency
          SET result = $4::jsonb
        WHERE scope_key = $1 AND idempotency_key = $2 AND semantic_hash = $3`,
      [input.scopeKey, input.idempotencyKey, input.semanticHash, JSON.stringify(input.result)],
    );
  }

  async readResult(scopeKey: string, idempotencyKey: string): Promise<unknown | null> {
    const rows = await this.db.query<{ result: unknown }>(
      this.uow.active,
      `SELECT result
         FROM form_idempotency
        WHERE scope_key = $1 AND idempotency_key = $2`,
      [scopeKey, idempotencyKey],
    );
    return rows[0]?.result ?? null;
  }

  async release(scopeKey: string, idempotencyKey: string): Promise<void> {
    await this.db.query(
      this.uow.active,
      `DELETE FROM form_idempotency
        WHERE scope_key = $1 AND idempotency_key = $2`,
      [scopeKey, idempotencyKey],
    );
  }
}
