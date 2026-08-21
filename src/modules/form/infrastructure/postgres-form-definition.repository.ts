/**
 * PostgreSQL 表单定义聚合仓储（infrastructure；DATA-FRM-001 持久化）。
 *
 * 表：form_definitions / form_versions / form_preview_tests /
 * form_template_publications（结构与迁移 20260820140000 逐列对齐）。
 *
 * 并发守卫（评审要求 SQL 层单胜者，IFC-ERR-010/IFC-GEN-007）：
 * - saveRoot：以根乐观版本为 WHERE 条件（0 行 → 版本冲突 IFC-ERR-008）；
 * - saveVersionWithStatusGuard：以期望状态为 WHERE 条件（0 行 → 单胜者失败）；
 * - saveTemplatePublicationWithStatusGuard：以 PENDING 状态为守卫（终态不可覆盖）。
 * 审计经 FormAuditPort 同事务记录，仓储不内嵌写入。
 */

import type { DbAdapter } from '../../../shared/db-adapter';
import type { FormUnitOfWork } from './unit-of-work';
import type { FormDefinitionSnapshot } from '../domain/models/form-definition';
import type { FormVersionSnapshot } from '../domain/models/form-version';
import type { FormScope } from '../domain/models/form-scope';
import type { FormVersionState } from '../domain/state-machines/form-version.state-machine';
import type { TemplatePublicationSnapshot } from '../domain/models/template-publication';
import type { FormDefinitionRepository } from '../application/ports/form-definition-repository.port';
import type { FormPreviewTestSnapshot } from '../application/ports/form-definition-repository.port';

interface RootRow {
  id: string;
  scope: string;
  owner_id: string | null;
  kind: string;
  title: string;
  description: string | null;
  business_family: string | null;
  current_draft_version: string | null;
  current_published_version: string | null;
  version: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface VersionRow {
  id: string;
  form_id: string;
  version_number: string;
  status: string;
  publishable: boolean;
  fields: FormVersionSnapshot['fields'];
  source_form_id: string | null;
  source_version: string | null;
  published_at: Date | null;
  published_by: string | null;
  deprecated_at: Date | null;
  deprecated_by: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface PreviewTestRow {
  id: string;
  form_id: string;
  version_number: string;
  result: string;
  summary: Record<string, unknown>;
  tested_by: string;
  tested_at: Date;
}

interface TemplatePublicationRow {
  id: string;
  form_id: string;
  source_version: string;
  status: string;
  note: string | null;
  requested_by: string;
  requested_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  template_form_id: string | null;
  version: string;
}

export class PostgresFormDefinitionRepository implements FormDefinitionRepository {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: FormUnitOfWork,
  ) {}

  async loadRoot(id: string): Promise<FormDefinitionSnapshot | null> {
    const rows = await this.db.query<RootRow>(
      this.uow.active,
      `SELECT id, scope, owner_id, kind, title, description, business_family,
              current_draft_version, current_published_version, version,
              created_by, created_at, updated_at
         FROM form_definitions
        WHERE id = $1`,
      [id],
    );
    return rows[0] ? rootRowToSnapshot(rows[0]) : null;
  }

  async listByScope(scope: FormScope): Promise<FormDefinitionSnapshot[]> {
    const rows = await this.db.query<RootRow>(
      this.uow.active,
      `SELECT id, scope, owner_id, kind, title, description, business_family,
              current_draft_version, current_published_version, version,
              created_by, created_at, updated_at
         FROM form_definitions
        WHERE scope = $1 AND owner_id IS NOT DISTINCT FROM $2
        ORDER BY updated_at DESC`,
      [scope.kind, scope.ownerId],
    );
    return rows.map((row) => rootRowToSnapshot(row));
  }

  async saveRoot(snapshot: FormDefinitionSnapshot, expectedVersion: number): Promise<void> {
    const rows = await this.db.query<{ id: string }>(
      this.uow.active,
      `INSERT INTO form_definitions
              (id, scope, owner_id, kind, title, description, business_family,
               current_draft_version, current_published_version, version,
               created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET
               title = EXCLUDED.title,
               description = EXCLUDED.description,
               business_family = EXCLUDED.business_family,
               current_draft_version = EXCLUDED.current_draft_version,
               current_published_version = EXCLUDED.current_published_version,
               version = EXCLUDED.version,
               updated_at = EXCLUDED.updated_at
        WHERE form_definitions.version = $14
       RETURNING id`,
      [
        snapshot.id,
        snapshot.scope.kind,
        snapshot.scope.ownerId,
        snapshot.kind,
        snapshot.title,
        snapshot.description,
        snapshot.businessFamily,
        snapshot.currentDraftVersion,
        snapshot.currentPublishedVersion,
        snapshot.version,
        snapshot.createdBy,
        snapshot.createdAt,
        snapshot.updatedAt,
        expectedVersion,
      ],
    );
    if (rows.length === 0) {
      throw new Error('FormDefinitionRepository.saveRoot: 根版本冲突（乐观锁未命中）');
    }
  }

  async loadVersion(formId: string, versionNumber: number): Promise<FormVersionSnapshot | null> {
    const rows = await this.db.query<VersionRow>(
      this.uow.active,
      `SELECT id, form_id, version_number, status, publishable, fields,
              source_form_id, source_version, published_at, published_by,
              deprecated_at, deprecated_by, created_by, created_at, updated_at
         FROM form_versions
        WHERE form_id = $1 AND version_number = $2`,
      [formId, versionNumber],
    );
    return rows[0] ? versionRowToSnapshot(rows[0]) : null;
  }

  async loadLatestVersion(formId: string): Promise<FormVersionSnapshot | null> {
    const rows = await this.db.query<VersionRow>(
      this.uow.active,
      `SELECT id, form_id, version_number, status, publishable, fields,
              source_form_id, source_version, published_at, published_by,
              deprecated_at, deprecated_by, created_by, created_at, updated_at
         FROM form_versions
        WHERE form_id = $1
        ORDER BY version_number DESC
        LIMIT 1`,
      [formId],
    );
    return rows[0] ? versionRowToSnapshot(rows[0]) : null;
  }

  async loadVersions(formId: string): Promise<FormVersionSnapshot[]> {
    const rows = await this.db.query<VersionRow>(
      this.uow.active,
      `SELECT id, form_id, version_number, status, publishable, fields,
              source_form_id, source_version, published_at, published_by,
              deprecated_at, deprecated_by, created_by, created_at, updated_at
         FROM form_versions
        WHERE form_id = $1
        ORDER BY version_number ASC`,
      [formId],
    );
    return rows.map((row) => versionRowToSnapshot(row));
  }

  async insertVersion(snapshot: FormVersionSnapshot): Promise<void> {
    const rows = await this.db.query<{ id: string }>(
      this.uow.active,
      `INSERT INTO form_versions
         (id, form_id, version_number, status, publishable, fields,
          source_form_id, source_version, published_at, published_by,
          deprecated_at, deprecated_by, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (form_id, version_number) DO NOTHING
       RETURNING id`,
      [
        snapshot.id,
        snapshot.formId,
        snapshot.versionNumber,
        snapshot.status,
        snapshot.publishable,
        JSON.stringify(snapshot.fields),
        snapshot.sourceFormId,
        snapshot.sourceVersion,
        snapshot.publishedAt,
        snapshot.publishedBy,
        snapshot.deprecatedAt,
        snapshot.deprecatedBy,
        snapshot.createdBy,
        snapshot.createdAt,
        snapshot.updatedAt,
      ],
    );
    if (rows.length === 0) {
      throw new Error('FormDefinitionRepository.insertVersion: 版本号冲突');
    }
  }

  async saveVersionWithStatusGuard(
    snapshot: FormVersionSnapshot,
    expectedStatus: FormVersionState,
  ): Promise<void> {
    const rows = await this.db.query<{ id: string }>(
      this.uow.active,
      `UPDATE form_versions
          SET status = $3,
              publishable = $4,
              published_at = $5,
              published_by = $6,
              deprecated_at = $7,
              deprecated_by = $8,
              updated_at = $9
        WHERE id = $1 AND status = $2
        RETURNING id`,
      [
        snapshot.id,
        expectedStatus,
        snapshot.status,
        snapshot.publishable,
        snapshot.publishedAt,
        snapshot.publishedBy,
        snapshot.deprecatedAt,
        snapshot.deprecatedBy,
        snapshot.updatedAt,
      ],
    );
    if (rows.length === 0) {
      throw new Error(
        'FormDefinitionRepository.saveVersionWithStatusGuard: 状态守卫未命中（并发单胜者冲突）',
      );
    }
  }

  async savePreviewTest(snapshot: FormPreviewTestSnapshot): Promise<void> {
    await this.db.query(
      this.uow.active,
      `INSERT INTO form_preview_tests (id, form_id, version_number, result, summary, tested_by, tested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (form_id, version_number) DO UPDATE SET
         result = EXCLUDED.result,
         summary = EXCLUDED.summary,
         tested_by = EXCLUDED.tested_by,
         tested_at = EXCLUDED.tested_at`,
      [
        snapshot.id,
        snapshot.formId,
        snapshot.versionNumber,
        snapshot.result,
        JSON.stringify(snapshot.summary),
        snapshot.testedBy,
        snapshot.testedAt,
      ],
    );
  }

  async loadPreviewTest(
    formId: string,
    versionNumber: number,
  ): Promise<FormPreviewTestSnapshot | null> {
    const rows = await this.db.query<PreviewTestRow>(
      this.uow.active,
      `SELECT id, form_id, version_number, result, summary, tested_by, tested_at
         FROM form_preview_tests
        WHERE form_id = $1 AND version_number = $2`,
      [formId, versionNumber],
    );
    return rows[0]
      ? {
          id: rows[0].id,
          formId: rows[0].form_id,
          versionNumber: Number(rows[0].version_number),
          result: rows[0].result as FormPreviewTestSnapshot['result'],
          summary: rows[0].summary,
          testedBy: rows[0].tested_by,
          testedAt: rows[0].tested_at,
        }
      : null;
  }

  async saveTemplatePublication(snapshot: TemplatePublicationSnapshot): Promise<void> {
    const rows = await this.db.query<{ id: string }>(
      this.uow.active,
      `INSERT INTO form_template_publications
         (id, form_id, source_version, status, note, requested_by, requested_at,
          decided_by, decided_at, decision_reason, template_form_id, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         note = EXCLUDED.note,
         decided_by = EXCLUDED.decided_by,
         decided_at = EXCLUDED.decided_at,
         decision_reason = EXCLUDED.decision_reason,
         template_form_id = EXCLUDED.template_form_id,
         version = EXCLUDED.version
       RETURNING id`,
      [
        snapshot.id,
        snapshot.formId,
        snapshot.sourceVersion,
        snapshot.status,
        snapshot.note,
        snapshot.requestedBy,
        snapshot.requestedAt,
        snapshot.decidedBy,
        snapshot.decidedAt,
        snapshot.decisionReason,
        snapshot.templateFormId,
        snapshot.version,
      ],
    );
    if (rows.length === 0) {
      throw new Error('FormDefinitionRepository.saveTemplatePublication: 写入失败');
    }
  }

  async loadTemplatePublication(id: string): Promise<TemplatePublicationSnapshot | null> {
    const rows = await this.db.query<TemplatePublicationRow>(
      this.uow.active,
      `SELECT id, form_id, source_version, status, note, requested_by, requested_at,
              decided_by, decided_at, decision_reason, template_form_id, version
         FROM form_template_publications
        WHERE id = $1`,
      [id],
    );
    return rows[0] ? templatePublicationRowToSnapshot(rows[0]) : null;
  }

  async listTemplatePublications(
    status: TemplatePublicationSnapshot['status'] | null,
  ): Promise<TemplatePublicationSnapshot[]> {
    const where = status === null ? '' : 'WHERE status = $1';
    const rows = await this.db.query<TemplatePublicationRow>(
      this.uow.active,
      `SELECT id, form_id, source_version, status, note, requested_by, requested_at,
              decided_by, decided_at, decision_reason, template_form_id, version
         FROM form_template_publications
        ${where}
        ORDER BY requested_at DESC`,
      status === null ? [] : [status],
    );
    return rows.map((row) => templatePublicationRowToSnapshot(row));
  }

  async saveTemplatePublicationWithStatusGuard(
    snapshot: TemplatePublicationSnapshot,
  ): Promise<void> {
    const rows = await this.db.query<{ id: string }>(
      this.uow.active,
      `UPDATE form_template_publications
          SET status = $3,
              decided_by = $4,
              decided_at = $5,
              decision_reason = $6,
              template_form_id = $7,
              version = version + 1
        WHERE id = $1 AND status = $2
        RETURNING id`,
      [
        snapshot.id,
        'PENDING',
        snapshot.status,
        snapshot.decidedBy,
        snapshot.decidedAt,
        snapshot.decisionReason,
        snapshot.templateFormId,
      ],
    );
    if (rows.length === 0) {
      throw new Error(
        'FormDefinitionRepository.saveTemplatePublicationWithStatusGuard: 状态守卫未命中',
      );
    }
  }
}

function rootRowToSnapshot(row: RootRow): FormDefinitionSnapshot {
  return {
    id: row.id,
    scope: { kind: row.scope as FormScope['kind'], ownerId: row.owner_id },
    kind: row.kind as FormDefinitionSnapshot['kind'],
    title: row.title,
    description: row.description,
    businessFamily: row.business_family,
    currentDraftVersion:
      row.current_draft_version === null ? null : Number(row.current_draft_version),
    currentPublishedVersion:
      row.current_published_version === null ? null : Number(row.current_published_version),
    version: Number(row.version),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function versionRowToSnapshot(row: VersionRow): FormVersionSnapshot {
  return {
    id: row.id,
    formId: row.form_id,
    versionNumber: Number(row.version_number),
    status: row.status as FormVersionSnapshot['status'],
    publishable: row.publishable,
    fields: row.fields,
    sourceFormId: row.source_form_id,
    sourceVersion: row.source_version === null ? null : Number(row.source_version),
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    deprecatedAt: row.deprecated_at,
    deprecatedBy: row.deprecated_by,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function templatePublicationRowToSnapshot(
  row: TemplatePublicationRow,
): TemplatePublicationSnapshot {
  return {
    id: row.id,
    formId: row.form_id,
    sourceVersion: Number(row.source_version),
    status: row.status as TemplatePublicationSnapshot['status'],
    note: row.note,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionReason: row.decision_reason,
    templateFormId: row.template_form_id,
    version: Number(row.version),
  };
}
