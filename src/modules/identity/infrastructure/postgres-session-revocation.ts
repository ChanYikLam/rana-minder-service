/**
 * PostgreSQL 会话失效（infrastructure；IDN-008/GOV-009/CAS-FAIL-002）。
 *
 * 表 auth_sessions：session_id text PK、subject_id uuid、revoke_version bigint、
 * revoked_at timestamptz null、created_at timestamptz。
 * 会话为无状态 JWT 不主动落行；invalidateAllSessions 使用 UPSERT 确保
 * 即使无既有行也能写入吊销记录（BUG-003/007 端到端闭环关键）。
 * getRevocation / invalidateAllSessions 各自管理独立事务（不依赖外部 uow.active），
 * 供无守卫端点（如 DELETE /logout）直接调用（Critical 3 修复）。
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
      const rows = await this.db.query<{
        revoke_version: string | null;
        revoked_at: Date | null;
      }>(tx, `SELECT MAX(revoke_version) AS revoke_version, MAX(revoked_at) AS revoked_at
           FROM auth_sessions WHERE subject_id = $1`, [subjectId]);
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

  /**
   * 吊销主体全部会话并推进撤销版本。
   *
   * Critical 2+3 修复：
   * - 自管理事务：不依赖 this.uow.active（无守卫端点直接调用时 uow.active 为 undefined 会抛错）；
   * - UPSERT 语义：即使该主体在 auth_sessions 中没有行（JWT 无状态会话从不落行），
   *   也插入一条吊销记录，确保读侧 getRevocation 能查到 revokedAt 并拦截旧令牌。
   */
  async invalidateAllSessions(subjectId: string): Promise<number> {
    const tx = await this.db.beginTransaction();
    try {
      await this.db.setRlsContext(tx, { kind: 'unprotected' });

      // 先加行锁串行化并发吊销（有行时）
      await this.db.query(
        tx,
        `SELECT session_id FROM auth_sessions WHERE subject_id = $1 FOR UPDATE`,
        [subjectId],
      );

      // UPSERT：无行时 INSERT 一条吊销记录（session_id 用 subjectId 前缀保证唯一）
      // 有行时 UPDATE 推进版本 + NOW()
      const result = await this.db.query<{ revoke_version: string }>(
        tx,
        `INSERT INTO auth_sessions (session_id, subject_id, revoke_version, revoked_at)
         VALUES ($2, $1, 1, NOW())
         ON CONFLICT (subject_id, revoked_at IS NOT NULL) DO NOTHING
         RETURNING revoke_version`,
        [subjectId, `revocation:${subjectId}`],
      );

      // 如果 UPSERT 未插入新行（已有活跃行），执行 UPDATE 推进版本
      if (result.length === 0) {
        const updated = await this.db.query<{ revoke_version: string }>(
          tx,
          `UPDATE auth_sessions
              SET revoke_version = COALESCE(
                    (SELECT MAX(revoke_version) FROM auth_sessions WHERE subject_id = $1), 0
                  ) + 1,
                  revoked_at = NOW()
            WHERE subject_id = $1
            RETURNING revoke_version`,
          [subjectId],
        );
        await this.db.commit(tx);
        return updated.length > 0 ? Number(updated[0].revoke_version) : 0;
      }

      await this.db.commit(tx);
      return Number(result[0].revoke_version);
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }
}
