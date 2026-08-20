/**
 * PostgreSQL 资料同步意图仓储（infrastructure；IDN-003 实体持久化）。
 *
 * 表 profile_sync_intents（PK (subject_id, field)，单字段单意图）：
 *   subject_id text
 *   field text
 *   id text
 *   target_version int
 *   prior_value text null
 *   target_value text
 *   readback_value text null
 *   state text
 *   conflict_version int null
 *   attempts int
 *   retry_at timestamptz null
 *   failed_since timestamptz null
 *   resolved_at timestamptz null
 *   created_at timestamptz
 */

import type { DbAdapter } from '../../../shared/db-adapter';
import type { IdentityUnitOfWork } from './unit-of-work';
import type {
  ProfileSyncIntentSnapshot,
  ProfileSyncDomainEvent,
} from '../domain/models/profile-sync-intent';
import type { EditableProfileField } from '../domain/models/profile-field';
import type { ProfileSyncIntentRepository } from '../application/ports/profile-sync-intent-repository.port';

interface Row {
  subject_id: string;
  field: string;
  id: string;
  target_version: number;
  prior_value: string | null;
  target_value: string;
  readback_value: string | null;
  state: string;
  conflict_version: number | null;
  attempts: number;
  retry_at: Date | null;
  failed_since: Date | null;
  resolved_at: Date | null;
  created_at: Date;
}

export class PostgresProfileSyncIntentRepository implements ProfileSyncIntentRepository {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: IdentityUnitOfWork,
  ) {}

  async load(subjectId: string, field: EditableProfileField): Promise<ProfileSyncIntentSnapshot | null> {
    const rows = await this.db.query<Row>(
      this.uow.active,
      `SELECT subject_id, field, id, target_version, prior_value, target_value, readback_value,
              state, conflict_version, attempts, retry_at, failed_since, resolved_at, created_at
         FROM profile_sync_intents
        WHERE subject_id = $1 AND field = $2`,
      [subjectId, field],
    );
    return rows[0] ? rowToSnapshot(rows[0]) : null;
  }

  async save(
    snapshot: ProfileSyncIntentSnapshot,
    events: readonly ProfileSyncDomainEvent[],
  ): Promise<void> {
    const tx = this.uow.active;
    await this.db.query(
      tx,
      `INSERT INTO profile_sync_intents
         (subject_id, field, id, target_version, prior_value, target_value, readback_value,
          state, conflict_version, attempts, retry_at, failed_since, resolved_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (subject_id, field) DO UPDATE SET
         id = EXCLUDED.id,
         target_version = EXCLUDED.target_version,
         prior_value = EXCLUDED.prior_value,
         target_value = EXCLUDED.target_value,
         readback_value = EXCLUDED.readback_value,
         state = EXCLUDED.state,
         conflict_version = EXCLUDED.conflict_version,
         attempts = EXCLUDED.attempts,
         retry_at = EXCLUDED.retry_at,
         failed_since = EXCLUDED.failed_since,
         resolved_at = EXCLUDED.resolved_at,
         created_at = EXCLUDED.created_at`,
      [
        snapshot.subjectId,
        snapshot.field,
        snapshot.id,
        snapshot.targetVersion,
        snapshot.priorValue,
        snapshot.targetValue,
        snapshot.readbackValue,
        snapshot.state,
        snapshot.conflictVersion,
        snapshot.attempts,
        snapshot.retryAt,
        snapshot.failedSince,
        snapshot.resolvedAt,
        snapshot.createdAt,
      ],
    );
    if (events.length > 0) {
      await this.db.query(
        tx,
        `INSERT INTO identity_audit (id, type, subject_id, occurred_at, actor, summary, trace_id)
         VALUES ($1, 'PROFILE_SYNC_OUTCOME', $2, NOW(), 'system', $3::jsonb, $4)`,
        [snapshot.id, snapshot.subjectId, JSON.stringify(serializeIntentEvents(events)), null],
      );
    }
  }
}

function rowToSnapshot(row: Row): ProfileSyncIntentSnapshot {
  return {
    id: row.id,
    subjectId: row.subject_id,
    field: row.field as EditableProfileField,
    targetVersion: row.target_version,
    priorValue: row.prior_value,
    targetValue: row.target_value,
    readbackValue: row.readback_value,
    state: row.state as ProfileSyncIntentSnapshot['state'],
    conflictVersion: row.conflict_version,
    attempts: row.attempts,
    retryAt: row.retry_at,
    failedSince: row.failed_since,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

function serializeIntentEvents(events: readonly ProfileSyncDomainEvent[]): unknown {
  return events.map((event) => ({
    type: event.type,
    occurredAt: event.occurredAt.toISOString(),
    payload: event.payload,
  }));
}