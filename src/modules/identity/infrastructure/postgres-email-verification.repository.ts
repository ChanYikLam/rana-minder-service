/**
 * PostgreSQL 邮箱验证请求仓储（infrastructure；IDN-011/IFC-TX-005 实体持久化）。
 *
 * 表 email_verification_requests：
 *   id text PK
 *   subject_id text
 *   email text
 *   token_hash text（只存哈希，不存明文令牌）
 *   expires_at timestamptz
 *   consumed_at timestamptz null
 *   request_version int
 *   created_at timestamptz
 */

import type { DbAdapter } from '../../../shared/db-adapter';
import type { IdentityUnitOfWork } from './unit-of-work';
import type { EmailVerificationSnapshot } from '../domain/models/email-verification';
import type { EmailVerificationRepository } from '../application/ports/email-verification-repository.port';

interface Row {
  id: string;
  subject_id: string;
  email: string;
  token_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  request_version: number;
  created_at: Date;
}

export class PostgresEmailVerificationRepository implements EmailVerificationRepository {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: IdentityUnitOfWork,
  ) {}

  async load(id: string): Promise<EmailVerificationSnapshot | null> {
    const rows = await this.db.query<Row>(
      this.uow.active,
      `SELECT id, subject_id, email, token_hash, expires_at, consumed_at, request_version, created_at
         FROM email_verification_requests
        WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToSnapshot(rows[0]) : null;
  }

  async save(snapshot: EmailVerificationSnapshot): Promise<void> {
    const tx = this.uow.active;
    await this.db.query(
      tx,
      `INSERT INTO email_verification_requests
         (id, subject_id, email, token_hash, expires_at, consumed_at, request_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         subject_id = EXCLUDED.subject_id,
         email = EXCLUDED.email,
         token_hash = EXCLUDED.token_hash,
         expires_at = EXCLUDED.expires_at,
         consumed_at = EXCLUDED.consumed_at,
         request_version = EXCLUDED.request_version,
         created_at = EXCLUDED.created_at`,
      [
        snapshot.id,
        snapshot.subjectId,
        snapshot.email,
        snapshot.tokenHash,
        snapshot.expiresAt,
        snapshot.consumedAt,
        snapshot.requestVersion,
        snapshot.createdAt,
      ],
    );
  }

  async findLatestBySubjectAndEmail(
    subjectId: string,
    email: string,
  ): Promise<EmailVerificationSnapshot | null> {
    const rows = await this.db.query<Row>(
      this.uow.active,
      `SELECT id, subject_id, email, token_hash, expires_at, consumed_at, request_version, created_at
         FROM email_verification_requests
        WHERE subject_id = $1 AND email = $2
        ORDER BY created_at DESC, request_version DESC
        LIMIT 1`,
      [subjectId, email],
    );
    return rows[0] ? rowToSnapshot(rows[0]) : null;
  }
}

function rowToSnapshot(row: Row): EmailVerificationSnapshot {
  return {
    id: row.id,
    subjectId: row.subject_id,
    email: row.email,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    requestVersion: row.request_version,
    createdAt: row.created_at,
  };
}