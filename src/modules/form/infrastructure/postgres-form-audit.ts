/**
 * PostgreSQL 表单域审计存储（infrastructure；ENG-004 §4、AUD-003）。
 *
 * 表 form_audit（不可变事实，与业务提交同事务）：
 *   id text PK
 *   type text
 *   subject_id text
 *   occurred_at timestamptz
 *   actor text
 *   summary jsonb（脱敏摘要，不含字段正文/附件/令牌）
 *   trace_id text null
 *
 * 审计保存失败时原命令回滚（FormUnitOfWork 事务边界保证）。
 */

import type { DbAdapter } from '../../../shared/db-adapter';
import type { FormUnitOfWork } from './unit-of-work';
import type { FormAuditPort, FormAuditFact } from '../application/ports/form-audit.port';

export class PostgresFormAudit implements FormAuditPort {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: FormUnitOfWork,
  ) {}

  async record(fact: FormAuditFact): Promise<void> {
    await this.db.query(
      this.uow.active,
      `INSERT INTO form_audit (id, type, subject_id, occurred_at, actor, summary, trace_id)
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
