/**
 * PostgreSQL 账号访问聚合根仓储（infrastructure；IDN-001 持久化）。
 *
 * 表 account_access：
 *   subject_id text PK
 *   state text
 *   state_version int
 *   degraded_since timestamptz null
 *   last_trusted_observation_at timestamptz
 *   session_revoke_version int
 *
 * 账号禁用/删除/降级/恢复与审计同事务提交（ENG-004/AUD-003）；
 * 会话撤销版本由聚合根推进，基础设施据此失效会话（IDN-008）。
 */

import type { DbAdapter } from '../../../shared/db-adapter';
import type { IdentityUnitOfWork } from './unit-of-work';
import type {
  AccountAccessSnapshot,
  AccountAccessDomainEvent,
} from '../domain/models/account-access';
import type { AccountAccessRepository } from '../application/ports/account-access-repository.port';

interface Row {
  subject_id: string;
  state: string;
  state_version: number;
  degraded_since: Date | null;
  last_trusted_observation_at: Date;
  session_revoke_version: number;
}

export class PostgresAccountAccessRepository implements AccountAccessRepository {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: IdentityUnitOfWork,
  ) {}

  async load(subjectId: string): Promise<AccountAccessSnapshot | null> {
    const rows = await this.db.query<Row>(
      this.uow.active,
      `SELECT subject_id, state, state_version, degraded_since, last_trusted_observation_at, session_revoke_version
         FROM account_access
        WHERE subject_id = $1`,
      [subjectId],
    );
    return rows[0] ? rowToSnapshot(rows[0]) : null;
  }

  async save(
    snapshot: AccountAccessSnapshot,
    events: readonly AccountAccessDomainEvent[],
  ): Promise<void> {
    const tx = this.uow.active;
    await this.db.query(
      tx,
      `INSERT INTO account_access
         (subject_id, state, state_version, degraded_since, last_trusted_observation_at, session_revoke_version)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (subject_id) DO UPDATE SET
         state = EXCLUDED.state,
         state_version = EXCLUDED.state_version,
         degraded_since = EXCLUDED.degraded_since,
         last_trusted_observation_at = EXCLUDED.last_trusted_observation_at,
         session_revoke_version = EXCLUDED.session_revoke_version`,
      [
        snapshot.subjectId,
        snapshot.state,
        snapshot.stateVersion,
        snapshot.degradedSince,
        snapshot.lastTrustedObservationAt,
        snapshot.sessionRevokeVersion,
      ],
    );
    if (events.length > 0) {
      await this.db.query(
        tx,
        `INSERT INTO identity_audit (id, type, subject_id, occurred_at, actor, summary, trace_id)
         VALUES ($1, 'ACCOUNT_ACCESS_CHANGED', $2, NOW(), 'system', $3::jsonb, $4)`,
        [snapshot.subjectId, snapshot.subjectId, JSON.stringify(serializeAccountEvents(events)), null],
      );
    }
  }
}

function rowToSnapshot(row: Row): AccountAccessSnapshot {
  return {
    subjectId: row.subject_id,
    state: row.state as AccountAccessSnapshot['state'],
    stateVersion: row.state_version,
    degradedSince: row.degraded_since,
    lastTrustedObservationAt: row.last_trusted_observation_at,
    sessionRevokeVersion: row.session_revoke_version,
  };
}

function serializeAccountEvents(events: readonly AccountAccessDomainEvent[]): unknown {
  return events.map((event) => ({
    type: event.type,
    occurredAt: event.occurredAt.toISOString(),
    payload: event.payload,
  }));
}