/**
 * 正式删除二次确认凭据 PostgreSQL 核验（4.2 收口；AUD-008 防绕过纵深防御）。
 *
 * 占位 LogOnlyFormalDeleteConfirm 恒 fail-closed（无法确认真实有效）——
 * 本实现将凭据持久化到 file_delete_confirmations：签发方 issue() 存证
 * （含过期时间），命令层 verify() 一次性核验（比对 + 作废 + 防重放）。
 * 删除清单持久化的 confirmationCode 为 SHA-256 哈希指纹（GOV-008 脱敏口径），
 * 明文仅在核验入口一次性消费——本实现按哈希指纹比对。
 */

import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { DbAdapter } from '../../../shared/db-adapter';
import { FILE_RLS_SCOPE } from './postgres-file-repository';
import type { FormalDeleteConfirmPort } from './formal-delete-confirm-port';

/** 确认码 → 哈希指纹（清单存证与核验比对统一口径；GOV-008 脱敏） */
export function confirmationFingerprint(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

@Injectable()
export class PostgresFormalDeleteConfirm implements FormalDeleteConfirmPort {
  constructor(private readonly db: DbAdapter) {}

  /**
   * 签发方接入：存证一次性确认凭据（含过期时间）。上层/审计二次确认流程调用。
   * 幂等：同 code 已存在则忽略（不覆盖已签发凭据，防重复签发覆盖作废状态）。
   */
  async issue(confirmationCode: string, expiresAt: Date): Promise<void> {
    const tx = await this.db.beginTransaction();
    try {
      await this.db.setRlsContext(tx, FILE_RLS_SCOPE);
      await this.db.query(
        tx,
        `INSERT INTO file_delete_confirmations (code, expires_at, created_at)
         VALUES ($1,$2,$3)
         ON CONFLICT (code) DO NOTHING`,
        [confirmationFingerprint(confirmationCode), expiresAt, new Date()],
      );
      await this.db.commit(tx);
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }

  /** 核验独立二次确认凭据真实有效：指纹存在 + 未过期 + 未消费 → 置消费作废并返回 true */
  async verify(confirmationCode: string): Promise<boolean> {
    const tx = await this.db.beginTransaction();
    try {
      await this.db.setRlsContext(tx, FILE_RLS_SCOPE);
      // 原子核验并作废（行锁防并发重复消费；一次性语义 AUD-008）
      const rows = await this.db.query<{ code: string }>(
        tx,
        `UPDATE file_delete_confirmations
            SET consumed_at = $2
          WHERE code = $1
            AND consumed_at IS NULL
            AND expires_at > $2
          RETURNING code`,
        [confirmationFingerprint(confirmationCode), new Date()],
      );
      await this.db.commit(tx);
      return rows.length === 1;
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }
}
