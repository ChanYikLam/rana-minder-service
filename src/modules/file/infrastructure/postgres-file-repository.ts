/**
 * 文件元数据 PostgreSQL 仓储（4.2 收口；ADR-008 元数据权威在 PostgreSQL）。
 *
 * 与 PostgresDeletionChecklistRepository 同构：DbAdapter + 独立事务（inTx）+ RLS。
 * 嵌套结构（scope/target/versions/upload_session/check_record/cleanup_queue/
 * deletion_manifest）以 jsonb 持久化，行映射纯函数导出便于单测。
 */

import { Injectable } from '@nestjs/common';
import type { DbAdapter, RlsScope, TransactionContext } from '../../../shared/db-adapter';
import type { FileRecord } from '../domain/models/file-model';

/** 文件域最小 RLS 上下文（首版 unprotected；数据隔离在组织/身份落地后细化） */
export const FILE_RLS_SCOPE: RlsScope = { kind: 'unprotected' };

/** file_records 行（与迁移 20260824150000 逐列对齐） */
export interface FileRecordRow {
  file_id: string;
  uploader_id: string;
  scope: unknown;
  category: string;
  state: string;
  target: unknown;
  version_no: number;
  versions: unknown;
  upload_session: unknown;
  check_record: unknown;
  cleanup_queue: unknown;
  deletion_manifest: unknown;
  created_at: Date;
  updated_at: Date;
}

/** jsonb 解析（迁移/工具可能返回 string 或已解析对象；string 由适配层预解析，此处双兼容） */
function parseJsonb<T>(value: unknown): T {
  if (typeof value === 'string') {
    return JSON.parse(value) as T;
  }
  return value as T;
}

/** 行 → 文件逻辑记录 */
export function fileRecordRowToSnapshot(row: FileRecordRow): FileRecord {
  return {
    fileId: row.file_id,
    uploaderId: row.uploader_id,
    scope: parseJsonb(row.scope),
    category: row.category as FileRecord['category'],
    state: row.state as FileRecord['state'],
    target: row.target === null ? null : parseJsonb(row.target),
    versionNo: Number(row.version_no),
    versions: parseJsonb<readonly FileRecord['versions'][number][]>(row.versions),
    uploadSession: row.upload_session === null ? null : parseJsonb(row.upload_session),
    checkRecord: row.check_record === null ? null : parseJsonb(row.check_record),
    cleanupQueue: parseJsonb(row.cleanup_queue),
    deletionManifest: row.deletion_manifest === null ? null : parseJsonb(row.deletion_manifest),
    createdAt: (row.created_at as Date).toISOString(),
  };
}

/** 文件逻辑记录 → 行（jsonb 序列化） */
export function fileRecordToRow(
  f: FileRecord,
  updatedAt: Date,
): Omit<FileRecordRow, 'updated_at'> & { updated_at: Date } {
  return {
    file_id: f.fileId,
    uploader_id: f.uploaderId,
    scope: f.scope as unknown,
    category: f.category,
    state: f.state,
    target: f.target === null ? null : (f.target as unknown),
    version_no: f.versionNo,
    versions: f.versions as unknown,
    upload_session: f.uploadSession === null ? null : (f.uploadSession as unknown),
    check_record: f.checkRecord === null ? null : (f.checkRecord as unknown),
    cleanup_queue: f.cleanupQueue as unknown,
    deletion_manifest: f.deletionManifest === null ? null : (f.deletionManifest as unknown),
    created_at: new Date(f.createdAt),
    updated_at: updatedAt,
  };
}

/** 目标对象过滤的 SQL 片段（listByTarget/createWithinTargetLimit 共用） */
const TARGET_WHERE = `target->>'objectType' = $1 AND target->>'objectId' = $2 AND target->>'fieldKey' = $3`;

@Injectable()
export class PostgresFileRepository {
  constructor(private readonly db: DbAdapter) {}

  /** 独立事务内执行 fn（文件仓储操作各自原子收口；ADR-008 §2.7 可恢复提交） */
  private async inTx<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const tx = await this.db.beginTransaction();
    try {
      await this.db.setRlsContext(tx, FILE_RLS_SCOPE);
      const result = await fn(tx);
      await this.db.commit(tx);
      return result;
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }

  async save(file: FileRecord): Promise<void> {
    await this.inTx(async (tx) => {
      const row = fileRecordToRow(file, new Date());
      await this.db.query(
        tx,
        `INSERT INTO file_records
           (file_id, uploader_id, scope, category, state, target, version_no, versions,
            upload_session, check_record, cleanup_queue, deletion_manifest, created_at, updated_at)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14)
         ON CONFLICT (file_id) DO UPDATE SET
           uploader_id = EXCLUDED.uploader_id, scope = EXCLUDED.scope, category = EXCLUDED.category,
           state = EXCLUDED.state, target = EXCLUDED.target, version_no = EXCLUDED.version_no,
           versions = EXCLUDED.versions, upload_session = EXCLUDED.upload_session,
           check_record = EXCLUDED.check_record, cleanup_queue = EXCLUDED.cleanup_queue,
           deletion_manifest = EXCLUDED.deletion_manifest, updated_at = EXCLUDED.updated_at`,
        [
          row.file_id,
          row.uploader_id,
          JSON.stringify(row.scope),
          row.category,
          row.state,
          row.target === null ? null : JSON.stringify(row.target),
          row.version_no,
          JSON.stringify(row.versions),
          row.upload_session === null ? null : JSON.stringify(row.upload_session),
          row.check_record === null ? null : JSON.stringify(row.check_record),
          JSON.stringify(row.cleanup_queue),
          row.deletion_manifest === null ? null : JSON.stringify(row.deletion_manifest),
          row.created_at,
          row.updated_at,
        ],
      );
    });
  }

  async load(fileId: string): Promise<FileRecord | null> {
    return this.inTx(async (tx) => {
      const rows = await this.db.query<FileRecordRow>(
        tx,
        `SELECT file_id, uploader_id, scope, category, state, target, version_no, versions,
                upload_session, check_record, cleanup_queue, deletion_manifest, created_at, updated_at
           FROM file_records WHERE file_id = $1`,
        [fileId],
      );
      return rows[0] ? fileRecordRowToSnapshot(rows[0]) : null;
    });
  }

  async listByTarget(target: {
    objectType: string;
    objectId: string;
    fieldKey: string;
  }): Promise<readonly FileRecord[]> {
    return this.inTx(async (tx) => {
      const rows = await this.db.query<FileRecordRow>(
        tx,
        `SELECT file_id, uploader_id, scope, category, state, target, version_no, versions,
                upload_session, check_record, cleanup_queue, deletion_manifest, created_at, updated_at
           FROM file_records WHERE ${TARGET_WHERE} ORDER BY created_at`,
        [target.objectType, target.objectId, target.fieldKey],
      );
      return rows.map(fileRecordRowToSnapshot);
    });
  }

  /**
   * 原子创建：目标字段附件数量上限内保存并返回 true；已满返回 false（IFC-FIL-001）。
   * 计数与保存在同一事务内完成，杜绝"先查后改"TOCTOU 竞态（并发 InitiateUpload
   * 不得突破 configuredPerField）。生产可配合目标行锁/唯一索引进一步串行化；
   * 表达式索引 idx_file_records_target 支撑计数查询。
   */
  async createWithinTargetLimit(
    target: { objectType: string; objectId: string; fieldKey: string },
    configuredPerField: number,
    file: FileRecord,
  ): Promise<boolean> {
    return this.inTx(async (tx) => {
      const counted = await this.db.query<{ n: number }>(
        tx,
        `SELECT count(*)::int AS n FROM file_records
          WHERE ${TARGET_WHERE} AND state NOT IN ('CLEANED', 'PENDING_CLEANUP', 'DELETED')`,
        [target.objectType, target.objectId, target.fieldKey],
      );
      if (counted.length === 0 || counted[0].n >= configuredPerField) {
        return false;
      }
      const row = fileRecordToRow(file, new Date());
      await this.db.query(
        tx,
        `INSERT INTO file_records
           (file_id, uploader_id, scope, category, state, target, version_no, versions,
            upload_session, check_record, cleanup_queue, deletion_manifest, created_at, updated_at)
         VALUES ($1,$2,$3::jsonb,$4,$5,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14)`,
        [
          row.file_id,
          row.uploader_id,
          JSON.stringify(row.scope),
          row.category,
          row.state,
          row.target === null ? null : JSON.stringify(row.target),
          row.version_no,
          JSON.stringify(row.versions),
          row.upload_session === null ? null : JSON.stringify(row.upload_session),
          row.check_record === null ? null : JSON.stringify(row.check_record),
          JSON.stringify(row.cleanup_queue),
          row.deletion_manifest === null ? null : JSON.stringify(row.deletion_manifest),
          row.created_at,
          row.updated_at,
        ],
      );
      return true;
    });
  }

  async nextVersionNo(fileId: string): Promise<number> {
    return this.inTx(async (tx) => {
      const rows = await this.db.query<{ max: number | null }>(
        tx,
        `SELECT max(version_no)::int AS max FROM file_records WHERE file_id = $1`,
        [fileId],
      );
      return (rows[0]?.max ?? 0) + 1;
    });
  }
}
