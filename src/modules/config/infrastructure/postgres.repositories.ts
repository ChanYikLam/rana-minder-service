/**
 * config 域 PostgreSQL 权威仓储（infrastructure；CFG-001~005）。
 *
 * 与 20260824000000_create-config-tables.ts 逐列对齐（迁移与仓储单源一致）。
 * 聚合快照整体读写：骨架列固定 + JSONB 承载数组/嵌套结构；读路径做 Date 复原
 * （JSONB 内时刻为 ISO 字符串，聚合与接口层依赖 Date 实例语义）。
 *
 * 全部读写经 ConfigUnitOfWork：调用方已显式开启事务则复用，否则自动开提单语句
 * 事务（runShared）。平台级单例表用 unprotected；社团作用域表读取走
 * collection-readonly（scopeKey=clubId），写入 unprotected（3.x RLS 细化前与
 * recruitment 同口径）。
 */

import type { DbAdapter, RlsScope } from '../../../shared/db-adapter';
import type { ConfigUnitOfWork } from './unit-of-work';

import type {
  ClubProfileSnapshot,
  ClubProfileFieldChange,
  ClubProfileHistoryEntry,
} from '../domain/models/club-profile';
import type {
  PlatformPolicyEntry,
  ClubPolicyEntry,
  PolicyChangeRecord,
} from '../domain/models/scoped-policy';
import type { AcademicYearSnapshot, AcademicYearBoundary } from '../domain/models/academic-year';
import type { ClubCohortSnapshot } from '../domain/models/club-cohort';
import type { ConfigRootSnapshot, ConfigVersionRecord } from '../domain/models/config-version';
import type { FieldMappingDraftState, FieldMappingEntry } from '../domain/models/field-mapping';

import type {
  ClubProfileRepositoryPort,
  ScopedPolicyTableRepositoryPort,
  AcademicYearBoundaryRepositoryPort,
  AcademicYearSettingsSnapshot,
  CohortRepositoryPort,
  ConfigRootRepositoryPort,
  FieldMappingStateRepositoryPort,
} from '../application/ports';

type Row = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}
function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string);
}
function dateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : date(value);
}
function json<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

// --------------------------------------------------------------------------
// CFG-001 社团展示资料
// --------------------------------------------------------------------------

function clubProfileFromRow(r: Row): ClubProfileSnapshot {
  const history = json<
    Array<
      Omit<ClubProfileHistoryEntry, 'at' | 'changes'> & {
        at: string | Date;
        changes: ClubProfileFieldChange[];
      }
    >
  >(r.history);
  return {
    clubId: String(r.club_id),
    displayName: String(r.display_name),
    logoFileRef: str(r.logo_file_ref),
    intro: str(r.intro),
    recruitmentNote: str(r.recruitment_note),
    internalNote: str(r.internal_note),
    contacts: json<ClubProfileSnapshot['contacts']>(r.contacts),
    history: history.map((h) => ({ ...h, at: date(h.at) })),
    revisionNumber: num(r.revision_number),
    updatedBy: str(r.updated_by),
    updatedAt: date(r.updated_at),
  };
}

export class PostgresClubProfileRepository implements ClubProfileRepositoryPort {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: ConfigUnitOfWork,
  ) {}

  async load(clubId: string): Promise<ClubProfileSnapshot | null> {
    const scope: RlsScope = { kind: 'collection-readonly', scopeKey: clubId };
    return this.uow.runShared(scope, async () => {
      const rows = await this.db.query<Row>(
        this.uow.active,
        `SELECT * FROM public.config_club_profiles WHERE club_id = $1`,
        [clubId],
      );
      return rows.length === 0 ? null : clubProfileFromRow(rows[0]);
    });
  }

  async save(snapshot: ClubProfileSnapshot): Promise<void> {
    await this.uow.runShared({ kind: 'unprotected' }, async () => {
      await this.db.query(
        this.uow.active,
        `INSERT INTO public.config_club_profiles
           (club_id, display_name, logo_file_ref, intro, recruitment_note, internal_note,
            contacts, history, revision_number, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)
         ON CONFLICT (club_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           logo_file_ref = EXCLUDED.logo_file_ref,
           intro = EXCLUDED.intro,
           recruitment_note = EXCLUDED.recruitment_note,
           internal_note = EXCLUDED.internal_note,
           contacts = EXCLUDED.contacts,
           history = EXCLUDED.history,
           revision_number = EXCLUDED.revision_number,
           updated_by = EXCLUDED.updated_by,
           updated_at = EXCLUDED.updated_at`,
        [
          snapshot.clubId,
          snapshot.displayName,
          snapshot.logoFileRef,
          snapshot.intro,
          snapshot.recruitmentNote,
          snapshot.internalNote,
          JSON.stringify(snapshot.contacts),
          JSON.stringify(snapshot.history),
          snapshot.revisionNumber,
          snapshot.updatedBy,
          snapshot.updatedAt,
        ],
      );
    });
  }
}

// --------------------------------------------------------------------------
// CFG-002 作用域策略表（全局单例）
// --------------------------------------------------------------------------

function policyTableFromRow(
  r: Row,
): import('../domain/models/scoped-policy').ScopedPolicyTableSnapshot {
  const platform = json<Record<string, PlatformPolicyEntry>>(r.platform);
  const revivedPlatform: Record<string, PlatformPolicyEntry> = {};
  for (const [key, entry] of Object.entries(platform)) {
    revivedPlatform[key] = { ...entry, updatedAt: date(entry.updatedAt) };
  }
  const clubs = json<Record<string, readonly ClubPolicyEntry[]>>(r.clubs);
  const revivedClubs: Record<string, readonly ClubPolicyEntry[]> = {};
  for (const [clubId, entries] of Object.entries(clubs)) {
    revivedClubs[clubId] = entries.map((e) => ({ ...e, updatedAt: date(e.updatedAt) }));
  }
  const changes = json<Array<Record<string, unknown>>>(r.changes).map((c) => ({
    ...(c as unknown as PolicyChangeRecord),
    at: date(c.at),
    effectiveAt: date(c.effectiveAt),
  }));
  return {
    platform:
      revivedPlatform as import('../domain/models/scoped-policy').ScopedPolicyTableSnapshot['platform'],
    clubs: revivedClubs,
    changes,
  };
}

export class PostgresScopedPolicyTableRepository implements ScopedPolicyTableRepositoryPort {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: ConfigUnitOfWork,
  ) {}

  async load(): Promise<import('../domain/models/scoped-policy').ScopedPolicyTableSnapshot | null> {
    return this.uow.runShared({ kind: 'unprotected' }, async () => {
      const rows = await this.db.query<Row>(
        this.uow.active,
        `SELECT platform, clubs, changes FROM public.config_scoped_policy_table WHERE id = 'singleton'`,
        [],
      );
      return rows.length === 0 ? null : policyTableFromRow(rows[0]);
    });
  }

  async save(
    snapshot: import('../domain/models/scoped-policy').ScopedPolicyTableSnapshot,
  ): Promise<void> {
    await this.uow.runShared({ kind: 'unprotected' }, async () => {
      await this.db.query(
        this.uow.active,
        `INSERT INTO public.config_scoped_policy_table (id, platform, clubs, changes)
         VALUES ('singleton', $1::jsonb, $2::jsonb, $3::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           platform = EXCLUDED.platform, clubs = EXCLUDED.clubs, changes = EXCLUDED.changes`,
        [
          JSON.stringify(snapshot.platform),
          JSON.stringify(snapshot.clubs),
          JSON.stringify(snapshot.changes),
        ],
      );
    });
  }
}

// --------------------------------------------------------------------------
// CFG-003 学年分界规则与届次
// --------------------------------------------------------------------------

function reviveYears(
  years: Array<{ name: string; startDate: string | Date; endDate: string | Date }>,
): AcademicYearSnapshot[] {
  return years.map((y) => ({
    name: y.name,
    startDate: date(y.startDate),
    endDate: date(y.endDate),
  }));
}

export class PostgresAcademicYearBoundaryRepository implements AcademicYearBoundaryRepositoryPort {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: ConfigUnitOfWork,
  ) {}

  async load(): Promise<AcademicYearSettingsSnapshot | null> {
    return this.uow.runShared({ kind: 'unprotected' }, async () => {
      const rows = await this.db.query<Row>(
        this.uow.active,
        `SELECT boundary, generated_years, last_changed_by, last_changed_at
           FROM public.config_academic_year_settings WHERE id = 'singleton'`,
        [],
      );
      if (rows.length === 0) {
        return null;
      }
      const r = rows[0];
      return {
        boundary: json<AcademicYearBoundary>(r.boundary),
        generatedYears: reviveYears(json(r.generated_years)),
        lastChangedBy: str(r.last_changed_by),
        lastChangedAt: dateOrNull(r.last_changed_at),
      };
    });
  }

  async save(snapshot: AcademicYearSettingsSnapshot): Promise<void> {
    await this.uow.runShared({ kind: 'unprotected' }, async () => {
      await this.db.query(
        this.uow.active,
        `INSERT INTO public.config_academic_year_settings
           (id, boundary, generated_years, last_changed_by, last_changed_at)
         VALUES ('singleton', $1::jsonb, $2::jsonb, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           boundary = EXCLUDED.boundary, generated_years = EXCLUDED.generated_years,
           last_changed_by = EXCLUDED.last_changed_by, last_changed_at = EXCLUDED.last_changed_at`,
        [
          JSON.stringify(snapshot.boundary),
          JSON.stringify(snapshot.generatedYears),
          snapshot.lastChangedBy,
          snapshot.lastChangedAt,
        ],
      );
    });
  }
}

function cohortFromRow(r: Row): ClubCohortSnapshot {
  return {
    id: String(r.id),
    clubId: String(r.club_id),
    name: String(r.name),
    academicYearName: String(r.academic_year_name),
    revisionNumber: num(r.revision_number),
    createdBy: String(r.created_by),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
    updatedBy: str(r.updated_by),
  };
}

export class PostgresCohortRepository implements CohortRepositoryPort {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: ConfigUnitOfWork,
  ) {}

  async listByClub(clubId: string): Promise<ClubCohortSnapshot[]> {
    const scope: RlsScope = { kind: 'collection-readonly', scopeKey: clubId };
    return this.uow.runShared(scope, async () => {
      const rows = await this.db.query<Row>(
        this.uow.active,
        `SELECT * FROM public.config_club_cohorts WHERE club_id = $1 ORDER BY created_at ASC`,
        [clubId],
      );
      return rows.map(cohortFromRow);
    });
  }

  async findById(cohortId: string): Promise<ClubCohortSnapshot | null> {
    const scope: RlsScope = { kind: 'collection-readonly', scopeKey: cohortId };
    return this.uow.runShared(scope, async () => {
      const rows = await this.db.query<Row>(
        this.uow.active,
        `SELECT * FROM public.config_club_cohorts WHERE id = $1`,
        [cohortId],
      );
      return rows.length === 0 ? null : cohortFromRow(rows[0]);
    });
  }

  async save(snapshot: ClubCohortSnapshot): Promise<void> {
    await this.uow.runShared({ kind: 'unprotected' }, async () => {
      await this.db.query(
        this.uow.active,
        `INSERT INTO public.config_club_cohorts
           (id, club_id, name, academic_year_name, revision_number, created_by, created_at, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, revision_number = EXCLUDED.revision_number,
           updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
        [
          snapshot.id,
          snapshot.clubId,
          snapshot.name,
          snapshot.academicYearName,
          snapshot.revisionNumber,
          snapshot.createdBy,
          snapshot.createdAt,
          snapshot.updatedAt,
          snapshot.updatedBy,
        ],
      );
    });
  }
}

// --------------------------------------------------------------------------
// CFG-005 配置根与不可变版本线（根行+版本行同事务写入）
// --------------------------------------------------------------------------

function versionFromRow(r: Row): ConfigVersionRecord {
  return {
    versionNumber: num(r.version_number),
    state: r.state as ConfigVersionRecord['state'],
    payload: json(r.payload),
    secretKind: r.secret_kind as ConfigVersionRecord['secretKind'],
    testResultRef: str(r.test_result_ref),
    sourceVersionNumber: r.source_version_number === null ? null : num(r.source_version_number),
    createdBy: String(r.created_by),
    createdAt: date(r.created_at),
    publishedAt: dateOrNull(r.published_at),
    publishedBy: str(r.published_by),
  };
}

export class PostgresConfigRootRepository implements ConfigRootRepositoryPort {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: ConfigUnitOfWork,
  ) {}

  async find(rootId: string): Promise<ConfigRootSnapshot | null> {
    return this.uow.runShared({ kind: 'unprotected' }, async () => {
      const rootRows = await this.db.query<Row>(
        this.uow.active,
        `SELECT kind, current_published_version_number FROM public.config_roots WHERE root_id = $1`,
        [rootId],
      );
      if (rootRows.length === 0) {
        return null;
      }
      const versionRows = await this.db.query<Row>(
        this.uow.active,
        `SELECT * FROM public.config_versions WHERE root_id = $1 ORDER BY version_number ASC`,
        [rootId],
      );
      return {
        rootId,
        kind: rootRows[0].kind as ConfigRootSnapshot['kind'],
        versions: versionRows.map(versionFromRow),
        currentPublishedVersionNumber:
          rootRows[0].current_published_version_number === null
            ? null
            : num(rootRows[0].current_published_version_number),
      };
    });
  }

  async save(snapshot: ConfigRootSnapshot): Promise<void> {
    await this.uow.runShared({ kind: 'unprotected' }, async () => {
      // 根行 upsert（当前指针）
      await this.db.query(
        this.uow.active,
        `INSERT INTO public.config_roots (root_id, kind, current_published_version_number)
         VALUES ($1,$2,$3)
         ON CONFLICT (root_id) DO UPDATE SET
           current_published_version_number = EXCLUDED.current_published_version_number`,
        [snapshot.rootId, snapshot.kind, snapshot.currentPublishedVersionNumber],
      );
      // 版本行只插入新号——同号已存在说明不可变版本遭改写，DO NOTHING 静默保旧
      // （应用层 editDraft 已拒绝非 DRAFT 改动，此为最后一道防线）
      for (const v of snapshot.versions) {
        await this.db.query(
          this.uow.active,
          `INSERT INTO public.config_versions
             (root_id, version_number, state, payload, secret_kind, test_result_ref,
              source_version_number, created_by, created_at, published_at, published_by)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (root_id, version_number) DO NOTHING`,
          [
            snapshot.rootId,
            v.versionNumber,
            v.state,
            JSON.stringify(v.payload),
            v.secretKind,
            v.testResultRef,
            v.sourceVersionNumber,
            v.createdBy,
            v.createdAt,
            v.publishedAt,
            v.publishedBy,
          ],
        );
      }
    });
  }
}

// --------------------------------------------------------------------------
// CFG-004 字段映射编辑态（全局单例）
// --------------------------------------------------------------------------

export class PostgresFieldMappingStateRepository implements FieldMappingStateRepositoryPort {
  constructor(
    private readonly db: DbAdapter,
    private readonly uow: ConfigUnitOfWork,
  ) {}

  async load(): Promise<FieldMappingDraftState | null> {
    return this.uow.runShared({ kind: 'unprotected' }, async () => {
      const rows = await this.db.query<Row>(
        this.uow.active,
        `SELECT entries, real_data_activated, revision_number, updated_by, updated_at
           FROM public.config_field_mapping_state WHERE id = 'singleton'`,
        [],
      );
      if (rows.length === 0) {
        return null;
      }
      const r = rows[0];
      return {
        entries: json<FieldMappingEntry[]>(r.entries),
        realDataActivated: Boolean(r.real_data_activated),
        revisionNumber: num(r.revision_number),
        updatedBy: str(r.updated_by),
        updatedAt: date(r.updated_at),
      };
    });
  }

  async save(state: FieldMappingDraftState): Promise<void> {
    await this.uow.runShared({ kind: 'unprotected' }, async () => {
      await this.db.query(
        this.uow.active,
        `INSERT INTO public.config_field_mapping_state
           (id, entries, real_data_activated, revision_number, updated_by, updated_at)
         VALUES ('singleton', $1::jsonb, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           entries = EXCLUDED.entries, real_data_activated = EXCLUDED.real_data_activated,
           revision_number = EXCLUDED.revision_number, updated_by = EXCLUDED.updated_by,
           updated_at = EXCLUDED.updated_at`,
        [
          JSON.stringify(state.entries),
          state.realDataActivated,
          state.revisionNumber,
          state.updatedBy,
          state.updatedAt,
        ],
      );
    });
  }
}
