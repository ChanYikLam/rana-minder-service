/**
 * 访问审计 PostgreSQL 持久化（4.2 收口；GOV-008/AUD-004）。
 *
 * 下载及敏感附件预览事件落库（不含正文；principal_id 完整标识合规存证——
 * 输出到日志/可视化一律经 maskPrincipal 脱敏，本实现只持久化不输出）。
 */

import { Injectable } from '@nestjs/common';
import type { DbAdapter } from '../../../shared/db-adapter';
import { FILE_RLS_SCOPE } from './postgres-file-repository';
import type { AccessAuditEvent, AccessAuditPort } from './access-audit-port';

@Injectable()
export class PostgresAccessAudit implements AccessAuditPort {
  constructor(private readonly db: DbAdapter) {}

  async report(event: AccessAuditEvent): Promise<void> {
    const tx = await this.db.beginTransaction();
    try {
      await this.db.setRlsContext(tx, FILE_RLS_SCOPE);
      await this.db.query(
        tx,
        `INSERT INTO file_access_audit
           (action, principal_id, file_id, sensitive, token, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          event.action,
          event.principalId,
          event.fileId,
          event.sensitive,
          event.token,
          new Date(event.occurredAt),
        ],
      );
      await this.db.commit(tx);
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }
}
