/**
 * PostgreSQL 平台公共资料仓储（infrastructure；IDN-002 聚合根持久化）。
 *
 * 表 identity_profiles（单数据库统一应用业务 Schema，ADR-014）：
 *   subject_id text PK
 *   fields jsonb（email/phone/college/grade）
 *   email_verified bool
 *   verified_email text null
 *   pending_email text null
 *   version int
 *   gate_state text
 *   restrictions jsonb（[{scopeKey,reason,since}]）
 *
 * 约束：只保存快照与领域事件；业务事实与同步意图/审计同事务提交（IFC-TX-001/003）。
 */

import type { DbAdapter } from '../../../shared/db-adapter';
import type { TransactionContext } from '../../../shared/db-adapter';
import type { IdentityUnitOfWork } from './unit-of-work';
import type {
  ProfileSnapshot,
  ProfileDomainEvent,
  ProfileFields,
} from '../domain/models/profile';
import type { ProfileRepository } from '../application/ports/profile-repository.port';

interface ProfileRow {
  subject_id: string;
  fields: string;
  email_verified: boolean;
  verified_email: string | null;
  pending_email: string | null;
  version: number;
  gate_state: string;
  restrictions: string;
}

export class PostgresProfileRepository implements ProfileRepository {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: IdentityUnitOfWork,
  ) {}

  async load(subjectId: string): Promise<ProfileSnapshot | null> {
    const rows = await this.db.query<ProfileRow>(
      this.uow.active,
      `SELECT subject_id, fields, email_verified, verified_email, pending_email, version, gate_state, restrictions
         FROM identity_profiles
        WHERE subject_id = $1`,
      [subjectId],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    return rowToSnapshot(row);
  }

  async save(snapshot: ProfileSnapshot, events: readonly ProfileDomainEvent[]): Promise<void> {
    const tx: TransactionContext = this.uow.active;
    await this.db.query(
      tx,
      `INSERT INTO identity_profiles
         (subject_id, fields, email_verified, verified_email, pending_email, version, gate_state, restrictions)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (subject_id) DO UPDATE SET
         fields = EXCLUDED.fields,
         email_verified = EXCLUDED.email_verified,
         verified_email = EXCLUDED.verified_email,
         pending_email = EXCLUDED.pending_email,
         version = EXCLUDED.version,
         gate_state = EXCLUDED.gate_state,
         restrictions = EXCLUDED.restrictions`,
      [
        snapshot.subjectId,
        JSON.stringify(snapshot.fields),
        snapshot.emailVerified,
        snapshot.verifiedEmail,
        snapshot.pendingEmail,
        snapshot.version,
        snapshot.gateState,
        JSON.stringify(snapshot.restrictions),
      ],
    );
    if (events.length > 0) {
      await this.db.query(
        tx,
        `INSERT INTO identity_audit (id, type, subject_id, occurred_at, actor, summary, trace_id)
         VALUES ($1, 'PROFILE_SAVED', $2, NOW(), 'system', $3::jsonb, $4)`,
        [snapshot.subjectId, snapshot.subjectId, JSON.stringify(serializeProfileEvents(events)), null],
      );
    }
  }
}

function rowToSnapshot(row: ProfileRow): ProfileSnapshot {
  return {
    subjectId: row.subject_id,
    fields: JSON.parse(row.fields) as ProfileFields,
    emailVerified: row.email_verified,
    verifiedEmail: row.verified_email,
    pendingEmail: row.pending_email,
    version: row.version,
    gateState: row.gate_state as ProfileSnapshot['gateState'],
    restrictions: JSON.parse(row.restrictions) as ProfileSnapshot['restrictions'],
  };
}

function serializeProfileEvents(events: readonly ProfileDomainEvent[]): unknown {
  return events.map((event) => ({
    type: event.type,
    occurredAt: event.occurredAt.toISOString(),
    payload: event.payload,
  }));
}