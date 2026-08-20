/**
 * PostgreSQL 身份域审计存储（infrastructure；ENG-004 §4、AUD-003）。
 *
 * 表 identity_audit（不可变事实，与业务提交同事务）：
 *   id text PK
 *   type text
 *   subject_id text
 *   occurred_at timestamptz
 *   actor text
 *   summary jsonb（脱敏摘要，不含令牌/附件正文/完整资料）
 *   trace_id text null
 *
 * 审计保存失败时原命令回滚（IdentityUnitOfWork 事务边界保证）。
 */

import type { DbAdapter } from '../../../shared/db-adapter';
import type { IdentityUnitOfWork } from './unit-of-work';
import type { IdentityAuditPort, IdentityAuditFact } from '../application/ports/identity-audit.port';

export class PostgresIdentityAudit implements IdentityAuditPort {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: IdentityUnitOfWork,
  ) {}

  async record(fact: IdentityAuditFact): Promise<void> {
    await this.db.query(
      this.uow.active,
      `INSERT INTO identity_audit (id, type, subject_id, occurred_at, actor, summary, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        `${fact.type}:${fact.subjectId}:${fact.occurredAt.getTime()}`,
        fact.type,
        fact.subjectId,
        fact.occurredAt,
        fact.actor,
        JSON.stringify(fact.summary),
        fact.traceId,
      ],
    );
  }
}