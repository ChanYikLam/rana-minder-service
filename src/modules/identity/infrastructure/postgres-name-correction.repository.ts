/**
 * PostgreSQL 姓名更正申请仓储（infrastructure；IDN-016 聚合根持久化）。
 *
 * 表 name_correction_requests：
 *   id uuid PK
 *   subject_id uuid not null
 *   old_name text not null
 *   requested_name text not null
 *   proof_reference text null
 *   status text not null（SUBMITTED/APPROVED/REJECTED）
 *   decided_by text null
 *   decided_at timestamptz null
 *   decision_reason text null
 *   applied_at timestamptz null
 *   version int not null
 *   created_at timestamptz not null
 *
 * 约束：同一主体同时最多一条 SUBMITTED（部分唯一索引）；申请事实与审计
 * 同事务提交（IFC-TX-001/003）。
 */

import type { DbAdapter } from '../../../shared/db-adapter';
import type { TransactionContext } from '../../../shared/db-adapter';
import type { IdentityUnitOfWork } from './unit-of-work';
import { identityErrors } from '../application/errors';
import type {
  NameCorrectionRequestSnapshot,
  NameCorrectionDomainEvent,
} from '../domain/models/name-correction-request';
import type { NameCorrectionRequestRepository } from '../application/ports/name-correction-repository.port';

interface NameCorrectionRow {
  id: string;
  subject_id: string;
  old_name: string;
  requested_name: string;
  proof_reference: string | null;
  status: string;
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  applied_at: Date | null;
  version: number;
  created_at: Date;
}

export class PostgresNameCorrectionRepository implements NameCorrectionRequestRepository {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: IdentityUnitOfWork,
  ) {}

  async load(id: string): Promise<NameCorrectionRequestSnapshot | null> {
    const rows = await this.db.query<NameCorrectionRow>(
      this.uow.active,
      `SELECT id, subject_id, old_name, requested_name, proof_reference, status,
              decided_by, decided_at, decision_reason, applied_at, version, created_at
         FROM name_correction_requests
        WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? rowToSnapshot(row) : null;
  }

  async findPendingBySubject(subjectId: string): Promise<NameCorrectionRequestSnapshot | null> {
    const rows = await this.db.query<NameCorrectionRow>(
      this.uow.active,
      `SELECT id, subject_id, old_name, requested_name, proof_reference, status,
              decided_by, decided_at, decision_reason, applied_at, version, created_at
         FROM name_correction_requests
        WHERE subject_id = $1 AND status = 'SUBMITTED'
        ORDER BY created_at DESC
        LIMIT 1`,
      [subjectId],
    );
    const row = rows[0];
    return row ? rowToSnapshot(row) : null;
  }

  async save(
    snapshot: NameCorrectionRequestSnapshot,
    events: readonly NameCorrectionDomainEvent[],
    expectedVersion: number,
  ): Promise<void> {
    const tx: TransactionContext = this.uow.active;
    const rows = await this.db.query<{ id: string }>(
      tx,
      `INSERT INTO name_correction_requests
         (id, subject_id, old_name, requested_name, proof_reference, status,
          decided_by, decided_at, decision_reason, applied_at, version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         decided_by = EXCLUDED.decided_by,
         decided_at = EXCLUDED.decided_at,
         decision_reason = EXCLUDED.decision_reason,
         applied_at = EXCLUDED.applied_at,
         version = EXCLUDED.version
       WHERE name_correction_requests.version = $13
       RETURNING id`,
      [
        snapshot.id,
        snapshot.subjectId,
        snapshot.oldName,
        snapshot.requestedName,
        snapshot.proofReference,
        snapshot.status,
        snapshot.decidedBy,
        snapshot.decidedAt,
        snapshot.decisionReason,
        snapshot.appliedAt,
        snapshot.version,
        snapshot.createdAt,
        expectedVersion,
      ],
    );
    if (rows.length === 0) {
      throw identityErrors.versionConflict();
    }
    void events;
  }
}

function rowToSnapshot(row: NameCorrectionRow): NameCorrectionRequestSnapshot {
  return {
    id: row.id,
    subjectId: row.subject_id,
    oldName: row.old_name,
    requestedName: row.requested_name,
    proofReference: row.proof_reference,
    status: row.status as NameCorrectionRequestSnapshot['status'],
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionReason: row.decision_reason,
    appliedAt: row.applied_at,
    version: row.version,
    createdAt: row.created_at,
  };
}
