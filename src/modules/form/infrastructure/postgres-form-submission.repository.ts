/**
 * PostgreSQL 表单提交仓储（infrastructure；FORM-002 持久化）。
 *
 * 表：form_submissions（结构与迁移 20260821100000 逐列对齐）。
 *
 * 并发守卫（IFC-ERR-010/IFC-GEN-007）：
 * - insert：以 id 主键冲突（0 行 → 调用方映射 IFC-ERR-008）；
 * - save：以修订号为 WHERE 条件（0 行 → 并发修订单胜者失败 IFC-ERR-008）。
 * 动态答案与修订历史入 values/revisions JSONB；读取时兼容 PG（对象）与内存测试
 * 替身（字符串）两种载荷。
 */

import type { DbAdapter } from '../../../shared/db-adapter';
import type { FormUnitOfWork } from './unit-of-work';
import type { FormSubmissionSnapshot } from '../domain/models/form-submission';
import type { FormScope } from '../domain/models/form-scope';
import type { FormSubmissionRepository } from '../application/ports/form-submission-repository.port';
import { formErrors } from '../application/errors';

interface SubmissionRow {
  id: string;
  form_id: string;
  version_number: string;
  scope: string;
  owner_id: string | null;
  submitted_by: string;
  values: unknown;
  status: string;
  revision_number: string;
  revisions: unknown;
  created_at: Date;
  updated_at: Date;
}

export class PostgresFormSubmissionRepository implements FormSubmissionRepository {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: FormUnitOfWork,
  ) {}

  async load(id: string): Promise<FormSubmissionSnapshot | null> {
    const rows = await this.db.query<SubmissionRow>(
      this.uow.active,
      `SELECT id, form_id, version_number, scope, owner_id, submitted_by, values,
              status, revision_number, revisions, created_at, updated_at
         FROM form_submissions
        WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToSnapshot(rows[0]) : null;
  }

  async loadBySubmitter(
    formId: string,
    versionNumber: number,
    submittedBy: string,
  ): Promise<FormSubmissionSnapshot | null> {
    const rows = await this.db.query<SubmissionRow>(
      this.uow.active,
      `SELECT id, form_id, version_number, scope, owner_id, submitted_by, values,
              status, revision_number, revisions, created_at, updated_at
         FROM form_submissions
        WHERE form_id = $1 AND version_number = $2 AND submitted_by = $3`,
      [formId, versionNumber, submittedBy],
    );
    return rows[0] ? rowToSnapshot(rows[0]) : null;
  }

  async listByScope(scope: FormScope): Promise<FormSubmissionSnapshot[]> {
    const rows = await this.db.query<SubmissionRow>(
      this.uow.active,
      `SELECT id, form_id, version_number, scope, owner_id, submitted_by, values,
              status, revision_number, revisions, created_at, updated_at
         FROM form_submissions
        WHERE scope = $1 AND owner_id IS NOT DISTINCT FROM $2
        ORDER BY updated_at DESC`,
      [scope.kind, scope.ownerId],
    );
    return rows.map((row) => rowToSnapshot(row));
  }

  async listByForm(formId: string, scope: FormScope): Promise<FormSubmissionSnapshot[]> {
    const rows = await this.db.query<SubmissionRow>(
      this.uow.active,
      `SELECT id, form_id, version_number, scope, owner_id, submitted_by, values,
              status, revision_number, revisions, created_at, updated_at
         FROM form_submissions
        WHERE form_id = $1 AND scope = $2 AND owner_id IS NOT DISTINCT FROM $3
        ORDER BY version_number DESC, revision_number DESC`,
      [formId, scope.kind, scope.ownerId],
    );
    return rows.map((row) => rowToSnapshot(row));
  }

  async insert(snapshot: FormSubmissionSnapshot): Promise<void> {
    const rows = await this.db.query<{ id: string }>(
      this.uow.active,
      `INSERT INTO form_submissions
              (id, form_id, version_number, scope, owner_id, submitted_by, values,
               status, revision_number, revisions, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (form_id, version_number, submitted_by) DO NOTHING
        RETURNING id`,
      [
        snapshot.id,
        snapshot.formId,
        snapshot.versionNumber,
        snapshot.scope.kind,
        snapshot.scope.ownerId,
        snapshot.submittedBy,
        JSON.stringify(snapshot.values),
        snapshot.status,
        snapshot.revisionNumber,
        JSON.stringify(snapshot.revisions),
        snapshot.createdAt,
        snapshot.updatedAt,
      ],
    );
    if (rows.length === 0) {
      // 并发重复提交：同一提交者对同一版本已存在记录（唯一约束命中）→ 409 IFC-ERR-010 资源争用
      throw formErrors.resourceContention('该提交者已提交过当前版本，请走修订');
    }
  }

  async save(snapshot: FormSubmissionSnapshot, expectedRevision: number): Promise<void> {
    const rows = await this.db.query<{ id: string }>(
      this.uow.active,
      `UPDATE form_submissions
          SET values = $3,
              status = $4,
              revision_number = $5,
              revisions = $6,
              updated_at = $7
        WHERE id = $1 AND revision_number = $2
        RETURNING id`,
      [
        snapshot.id,
        expectedRevision,
        JSON.stringify(snapshot.values),
        snapshot.status,
        snapshot.revisionNumber,
        JSON.stringify(snapshot.revisions),
        snapshot.updatedAt,
      ],
    );
    if (rows.length === 0) {
      // 并发修订单胜者失败：修订号乐观守卫未命中 → 409 IFC-ERR-010
      throw formErrors.resourceContention('提交已被他人修订，请刷新后重试');
    }
  }
}

function parseJsonb<T>(value: unknown): T {
  if (typeof value === 'string') {
    return JSON.parse(value) as T;
  }
  return value as T;
}

function rowToSnapshot(row: SubmissionRow): FormSubmissionSnapshot {
  return {
    id: row.id,
    formId: row.form_id,
    versionNumber: Number(row.version_number),
    scope: { kind: row.scope as FormScope['kind'], ownerId: row.owner_id },
    submittedBy: row.submitted_by,
    values: parseJsonb<FormSubmissionSnapshot['values']>(row.values),
    status: row.status as FormSubmissionSnapshot['status'],
    revisionNumber: Number(row.revision_number),
    revisions: parseJsonb<FormSubmissionSnapshot['revisions']>(row.revisions),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
