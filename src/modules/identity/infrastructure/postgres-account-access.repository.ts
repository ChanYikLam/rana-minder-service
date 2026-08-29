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
import { identityErrors } from '../application/errors';

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
    expectedStateVersion: number,
    events: readonly AccountAccessDomainEvent[],
  ): Promise<void> {
    const tx = this.uow.active;
    // INSERT...ON CONFLICT...DO UPDATE 复合 CAS 守卫（Top 1/C1：账号禁用/删除不被并发新登录覆盖）：
    //   - INSERT 新行（subject_id PK 无冲突）：直接插入成功；returns 1 row。
    //   - DO UPDATE 受 `expectedStateVersion` 守卫：调用方读取旧 stateVersion 后，
    //     DB 行在并发间隙被改 → state_version != expectedStateVersion → 0 行 → 抛 CAS 冲突。
    // 避免无锁 last-write-wins 覆盖陈旧 DISABLED/DELETED 状态。
    const rows = await this.db.query<{ subject_id: string }>(
      tx,
      `INSERT INTO account_access
         (subject_id, state, state_version, degraded_since, last_trusted_observation_at, session_revoke_version)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (subject_id) DO UPDATE SET
         state = EXCLUDED.state,
         state_version = EXCLUDED.state_version,
         degraded_since = EXCLUDED.degraded_since,
         last_trusted_observation_at = EXCLUDED.last_trusted_observation_at,
         session_revoke_version = EXCLUDED.session_revoke_version
       WHERE account_access.state_version = $7
       RETURNING subject_id`,
      [
        snapshot.subjectId,
        snapshot.state,
        snapshot.stateVersion,
        snapshot.degradedSince,
        snapshot.lastTrustedObservationAt,
        snapshot.sessionRevokeVersion,
        expectedStateVersion,
      ],
    );
    if (rows.length === 0) {
      // 0 行意味着：调用方期待的 state_version 与 DB 当前不匹配（CAS 失败）。
      // 新建主体路径无冲突，INSERT 总会返回 1 行；此处仅由 UPDATE 失败触发。
      throw identityErrors.versionConflict();
    }
    void events; // 审计由应用层经 IdentityAuditPort 同事务记录，仓储不再内嵌写入
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
