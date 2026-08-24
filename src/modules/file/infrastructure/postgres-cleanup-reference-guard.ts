/**
 * 清理引用复核 PostgreSQL 全库核对（4.2 收口；FORM-009/IFC-FIL-009）。
 *
 * 占位 LogOnlyCleanupReferenceGuard 恒 fail-closed（视为仍被引用）——
 * 本实现基于 file_records 全库核对：对象定位（bucketRole/keyVersion/
 * objectKind/randomKey）仍被任一活跃文件版本引用（非已清理/待清理终态），
 * 则判定"仍被引用"拒绝物理删除；确无引用才放行。
 */

import { Injectable } from '@nestjs/common';
import type { DbAdapter } from '../../../shared/db-adapter';
import { FILE_RLS_SCOPE } from './postgres-file-repository';
import type { ObjectLocation } from '../domain/models/file-model';
import type { CleanupReferenceGuardPort } from './cleanup-reference-guard-port';

@Injectable()
export class PostgresCleanupReferenceGuard implements CleanupReferenceGuardPort {
  constructor(private readonly db: DbAdapter) {}

  /** 对象是否仍被有效访问路径/活跃文件引用（true=不得物理删除） */
  async hasActiveReference(location: ObjectLocation): Promise<boolean> {
    const tx = await this.db.beginTransaction();
    try {
      await this.db.setRlsContext(tx, FILE_RLS_SCOPE);
      // 引用核对：versions jsonb 中任一版本对象定位完全匹配，且文件仍持有有效
      // 访问路径。**必须排除 PENDING_CLEANUP**（评审 warning 修复）：RemoveDraftFile
      // 将文件置待清理但 versions 原样保留（对象同时登记 cleanupQueue）——不排除会
      // 命中自身 versions 判"仍被引用"，孤儿对象永不物理删除，违反 FORM-009 收敛。
      const rows = await this.db.query<{ n: number }>(
        tx,
        `SELECT count(*)::int AS n FROM file_records
          WHERE state NOT IN ('CLEANED', 'DELETED', 'PENDING_CLEANUP')
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(versions) v
              WHERE v->'objectLocation'->>'bucketRole' = $1
                AND v->'objectLocation'->>'keyVersion' = $2
                AND v->'objectLocation'->>'objectKind' = $3
                AND v->'objectLocation'->>'randomKey' = $4
            )`,
        [location.bucketRole, location.keyVersion, location.objectKind, location.randomKey],
      );
      await this.db.commit(tx);
      return rows.length > 0 && rows[0].n > 0;
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }
}
