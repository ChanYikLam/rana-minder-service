/**
 * PostgreSQL 最近重新认证证据（infrastructure；CAS-REC-003）。
 *
 * 表 auth_reauth_evidence：subject_id uuid PK、reauth_at timestamptz。
 * 认证链路（3.3）在成功重新认证时登记；本存储只保存时间戳与服务端会话引用，
 * 不存令牌/口令（CAS-SEC-001~004）。高风险命令按最近 10 分钟窗口判定。
 */

import type { DbAdapter } from '../../../shared/db-adapter';
import type { IdentityUnitOfWork } from './unit-of-work';
import type { ReauthEvidencePort } from '../application/ports/reauth-evidence.port';

interface ReauthRow {
  reauth_at: Date;
}

export class PostgresReauthEvidence implements ReauthEvidencePort {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: IdentityUnitOfWork,
  ) {}

  async latestReauthAt(subjectId: string): Promise<Date | null> {
    const rows = await this.db.query<ReauthRow>(
      this.uow.active,
      `SELECT reauth_at
         FROM auth_reauth_evidence
        WHERE subject_id = $1`,
      [subjectId],
    );
    const row = rows[0];
    return row ? row.reauth_at : null;
  }

  async record(subjectId: string, at: Date): Promise<void> {
    await this.db.query(
      this.uow.active,
      `INSERT INTO auth_reauth_evidence (subject_id, reauth_at)
       VALUES ($1, $2)
       ON CONFLICT (subject_id) DO UPDATE SET reauth_at = EXCLUDED.reauth_at`,
      [subjectId, at],
    );
  }
}
