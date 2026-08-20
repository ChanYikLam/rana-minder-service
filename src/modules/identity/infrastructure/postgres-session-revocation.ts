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
}