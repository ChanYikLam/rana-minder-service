/**
 * PostgreSQL 会话失效（infrastructure；IDN-008/GOV-009/CAS-FAIL-002）。
 *
 * 表 auth_sessions：session_id text PK、subject_id uuid、revoke_version bigint、
 * revoked_at timestamptz null、created_at timestamptz。
 * 会话由认证链路（3.3）创建；本存储按主体把全部未失效会话标记到当前撤销版本，
 * 会话服务据此拒绝继续使用。与账号状态转换同事务提交（IFC-TX-001）。
 */

import type { DbAdapter } from '../../../shared/db-adapter';
import type { IdentityUnitOfWork } from './unit-of-work';
import type { SessionRevocationPort } from '../application/ports/session-revocation.port';

export class PostgresSessionRevocation implements SessionRevocationPort {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: IdentityUnitOfWork,
  ) {}

  async invalidateSessions(subjectId: string, revokeVersion: number): Promise<void> {
    await this.db.query(
      this.uow.active,
      `UPDATE auth_sessions
          SET revoke_version = $2, revoked_at = NOW()
        WHERE subject_id = $1 AND revoked_at IS NULL`,
      [subjectId, revokeVersion],
    );
  }

  async getRevocation(
    subjectId: string,
  ): Promise<{ revokeVersion: number; revokedAt: string | null } | null> {
    const tx = await this.db.beginTransaction();
    try {
      await this.db.setRlsContext(tx, { kind: 'unprotected' });
      const rows = await this.db.query<{ revoke_version: string | null; revoked_at: Date | null }>(
        tx,
        `SELECT MAX(revoke_version) AS revoke_version, MAX(revoked_at) AS revoked_at
           FROM auth_sessions WHERE subject_id = $1`,
        [subjectId],
      );
      await this.db.commit(tx);
      const row = rows[0];
      if (!row || row.revoke_version === null) {
        return null;
      }
      return {
        revokeVersion: Number(row.revoke_version),
        revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
      };
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }

  async invalidateAllSessions(subjectId: string): Promise<number> {
    const rows = await this.db.query<{ revoke_version: string }>(
      this.uow.active,
      `UPDATE auth_sessions
          SET revoke_version = COALESCE(
                (SELECT MAX(revoke_version) FROM auth_sessions WHERE subject_id = $1), 0
              ) + 1,
              revoked_at = NOW()
        WHERE subject_id = $1 AND revoked_at IS NULL
        RETURNING revoke_version`,
      [subjectId],
    );
    return rows.length > 0 ? Number(rows[0].revoke_version) : 0;
  }
}
