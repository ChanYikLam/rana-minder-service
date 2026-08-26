/**
 * PostgreSQL 会话失效（infrastructure；IDN-008/GOV-009/CAS-FAIL-002）。
 *
 * 表 auth_sessions：session_id text PK、subject_id text、revoke_version bigint、
 * revoked_at timestamptz null、created_at timestamptz。
 * 会话为无状态 JWT 不主动落行；invalidateAllSessions 在无既有会话行时也会
 * 写入一条吊销记录（BUG-003/007 端到端闭环关键），确保读侧 getRevocation
 * 能查到 revokedAt 并拦截旧令牌。
 *
 * 事务约束（安全控制，SEC-CTL-004 / IFC-TX-001）：
 * - invalidateSessions / invalidateAllSessions 必须在身份域工作单元事务内
 *   （this.uow.active）执行——禁止脱离事务读写；
 * - getRevocation 为只读查询，自管理只读事务（供认证链路 resolveSession 使用，
 *   不依赖外部 uow.active）。
 */

import { randomUUID } from 'node:crypto';
import type { DbAdapter } from '../../../shared/db-adapter';
import type { IdentityUnitOfWork } from './unit-of-work';
import type { SessionRevocationPort } from '../application/ports/session-revocation.port';

export class PostgresSessionRevocation implements SessionRevocationPort {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: IdentityUnitOfWork,
  ) {}

  /**
   * 吊销主体全部未失效会话并写入指定撤销版本（账号禁用/删除路径，BUG-003 写侧）。
   *
   * BUG-003 闭环关键：无状态 JWT 会话从不落行，若只做 UPDATE，空表场景恒命中 0 行、
   * 吊销记录不落库，读侧 getRevocation 将永远查不到 revokedAt，禁用账号令牌仍可用到
   * 24h 过期（验收标准 ≤5s 失效未达成）。故先加行锁串行化并发吊销、UPDATE 既有未失效
   * 会话行；若无行可更新（从未落行或已全部吊销），则 INSERT 一条吊销记录，保证读侧
   * 能拦截旧令牌。
   *
   * 必须在身份域工作单元事务内执行（this.uow.active；安全控制 SEC-CTL-004）。
   */
  async invalidateSessions(subjectId: string, revokeVersion: number): Promise<void> {
    const tx = this.uow.active;

    // 对该主体全部会话行加行锁，串行化同一主体并发吊销（与 invalidateAllSessions 一致）。
    await this.db.query(
      tx,
      `SELECT session_id FROM auth_sessions WHERE subject_id = $1 FOR UPDATE`,
      [subjectId],
    );

    // 1) 推进既有未失效会话行的撤销版本（有会话行时）
    const updated = await this.db.query(
      tx,
      `UPDATE auth_sessions
          SET revoke_version = $2, revoked_at = NOW()
        WHERE subject_id = $1 AND revoked_at IS NULL
        RETURNING session_id`,
      [subjectId, revokeVersion],
    );
    if (updated.length > 0) {
      return;
    }

    // 2) 无未失效会话行（无状态 JWT 空表）：插入一条吊销记录，确保读侧可拦截旧令牌。
    //    session_id 用 randomUUID 保证唯一，版本沿用账号状态机传入的 revokeVersion。
    await this.db.query(
      tx,
      `INSERT INTO auth_sessions (session_id, subject_id, revoke_version, revoked_at)
       VALUES ($2, $1, $3, NOW())`,
      [subjectId, `revocation:${subjectId}:${randomUUID()}`, revokeVersion],
    );
  }

  async getRevocation(
    subjectId: string,
  ): Promise<{ revokeVersion: number; revokedAt: string | null } | null> {
    const tx = await this.db.beginTransaction();
    try {
      await this.db.setRlsContext(tx, { kind: 'unprotected' });
      // 取撤销版本最高的一行（即最近一次吊销），版本与时间来自同一行，
      // 避免 MAX(revoke_version) 与 MAX(revoked_at) 取自不同行导致的状态不一致。
      const rows = await this.db.query<{
        revoke_version: string | null;
        revoked_at: Date | null;
      }>(
        tx,
        `SELECT revoke_version, revoked_at
           FROM auth_sessions WHERE subject_id = $1
          ORDER BY revoke_version DESC
          LIMIT 1`,
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

  /**
   * 吊销主体全部会话并推进撤销版本。
   *
   * BUG-003/007 端到端闭环关键：无状态 JWT 会话从不落行，若只做 UPDATE，
   * 空表场景恒命中 0 行、吊销记录不落库，读侧 getRevocation 将永远查不到
   * revokedAt。故先 UPDATE 既有未失效会话行推进版本；若无行可更新（从未落行
   * 或已全部吊销），则 INSERT 一条吊销记录，保证读侧可拦截旧令牌。
   *
   * 必须在身份域工作单元事务内执行（this.uow.active；安全控制 SEC-CTL-004，
   * 禁止脱离事务读写）。
   */
  async invalidateAllSessions(subjectId: string): Promise<number> {
    const tx = this.uow.active;

    // 0) 先对该主体的全部会话行加行锁（FOR UPDATE），串行化同一主体的并发吊销：
    //    否则两个并发事务可能基于相同的 MAX(revoke_version) 各自 +1，得到相同版本号
    //    （撤销版本回退/不单调）。加锁后第二个事务的 FOR UPDATE 会阻塞直至第一个
    //    事务提交，再基于最新数据计算下一版本。空表时锁 0 行、无法串行化，但
    //    session_id 用 randomUUID 保证唯一，不会主键冲突，且读侧拦截依赖 revokedAt
    //    而非版本号，安全不失效（并发登出同主体概率极低）。
    await this.db.query(
      tx,
      `SELECT session_id FROM auth_sessions WHERE subject_id = $1 FOR UPDATE`,
      [subjectId],
    );

    // 1) 推进既有未失效会话行的撤销版本（有会话行时）
    const updated = await this.db.query<{ revoke_version: string }>(
      tx,
      `UPDATE auth_sessions
          SET revoke_version = COALESCE(
                (SELECT MAX(revoke_version) FROM auth_sessions WHERE subject_id = $1), 0
              ) + 1,
              revoked_at = NOW()
        WHERE subject_id = $1 AND revoked_at IS NULL
        RETURNING revoke_version`,
      [subjectId],
    );
    if (updated.length > 0) {
      return Number(updated[0].revoke_version);
    }

    // 2) 无未失效会话行：插入一条吊销记录（session_id 用 randomUUID 保证唯一，
    //    避免同主体并发/同毫秒场景主键冲突；版本承接该主体历史最大版本 +1，
    //    配合上方 FOR UPDATE 行锁保证单调递增）。
    const inserted = await this.db.query<{ revoke_version: string }>(
      tx,
      `INSERT INTO auth_sessions (session_id, subject_id, revoke_version, revoked_at)
       VALUES ($2, $1,
               (SELECT COALESCE(MAX(revoke_version), 0)
                  FROM auth_sessions WHERE subject_id = $1) + 1,
               NOW())
       RETURNING revoke_version`,
      [subjectId, `revocation:${subjectId}:${randomUUID()}`],
    );
    return Number(inserted[0].revoke_version);
  }
}
