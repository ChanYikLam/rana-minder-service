/**
 * 迁移：配置平台表（config 域，5.5 CFG-001~005）
 *
 * 版本：20260824000000
 * 归属模块：config（ADR-002 §2.1；5.5）
 * 权威来源：src/modules/config/domain 各聚合快照；与
 * postgres.repositories.ts 逐列对齐（迁移与仓储单源一致）。
 *
 * 约束：
 * - 仅受控开发/测试环境；生产 DDL 门保持关闭（GOV-CODE-WAIVER-001）。
 * - 聚合内数组/嵌套结构（联系方式、修改历史、策略条目、学年区间、版本线 payload）
 *   入 JSONB；业务骨架列固定。
 * - 单例表以 CHECK (id='singleton') 保证全局唯一行。
 */

export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  // CFG-001 社团展示资料：一社团一行；contacts/history 入 JSONB
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.config_club_profiles (
      club_id           text        PRIMARY KEY,
      display_name      text        NOT NULL,
      logo_file_ref     text        NULL,
      intro             text        NULL,
      recruitment_note  text        NULL,
      internal_note     text        NULL,
      contacts          jsonb       NOT NULL DEFAULT '[]'::jsonb,
      history           jsonb       NOT NULL DEFAULT '[]'::jsonb,
      revision_number   bigint      NOT NULL DEFAULT 1,
      updated_by        text        NULL,
      updated_at        timestamptz NOT NULL DEFAULT now()
    )
  `);

  // CFG-002 作用域策略表（全局单例）：平台/社团条目与只追加留痕入 JSONB
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.config_scoped_policy_table (
      id         text PRIMARY KEY CHECK (id = 'singleton'),
      platform   jsonb       NOT NULL,
      clubs      jsonb       NOT NULL DEFAULT '{}'::jsonb,
      changes    jsonb       NOT NULL DEFAULT '[]'::jsonb
    )
  `);

  // CFG-003 学年分界规则与已生成学年（全局单例）
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.config_academic_year_settings (
      id               text PRIMARY KEY CHECK (id = 'singleton'),
      boundary         jsonb       NOT NULL,
      generated_years  jsonb       NOT NULL DEFAULT '[]'::jsonb,
      last_changed_by  text        NULL,
      last_changed_at  timestamptz NULL
    )
  `);

  // CFG-003 社团届次：同学年同名唯一（换届须新建届次，关联学年在创建后不可变）
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.config_club_cohorts (
      id                  text        PRIMARY KEY,
      club_id             text        NOT NULL,
      name                text        NOT NULL,
      academic_year_name  text        NOT NULL,
      revision_number     bigint      NOT NULL DEFAULT 1,
      created_by          text        NOT NULL,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      updated_by          text        NULL,
      CONSTRAINT uq_config_cohorts_club_year_name UNIQUE (club_id, academic_year_name, name)
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_config_cohorts_club
      ON public.config_club_cohorts (club_id)
  `);

  // CFG-005 配置根与不可变版本（DATA-CFG-001：根＋不可变发布版本＋当前指针＋历史）
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.config_roots (
      root_id                         text   PRIMARY KEY,
      kind                            text   NOT NULL,
      current_published_version_number bigint NULL,
      CONSTRAINT ck_config_roots_kind CHECK (kind IN
        ('FORM_TEMPLATE','NOTIFY_TEMPLATE','PERMISSION_TEMPLATE','FIELD_MAPPING','PLATFORM_POLICY'))
    )
  `);
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.config_versions (
      root_id               text        NOT NULL REFERENCES public.config_roots (root_id),
      version_number        bigint      NOT NULL,
      state                 text        NOT NULL,
      payload               jsonb       NOT NULL DEFAULT '{}'::jsonb,
      secret_kind           text        NOT NULL DEFAULT 'NONE',
      test_result_ref       text        NULL,
      source_version_number bigint      NULL,
      created_by            text        NOT NULL,
      created_at            timestamptz NOT NULL DEFAULT now(),
      published_at          timestamptz NULL,
      published_by          text        NULL,
      PRIMARY KEY (root_id, version_number),
      CONSTRAINT ck_config_versions_state CHECK (state IN
        ('DRAFT','TESTING','READY_TO_PUBLISH','PUBLISHED')),
      CONSTRAINT ck_config_versions_secret_kind CHECK (secret_kind IN ('NONE','MAIL_CREDENTIAL'))
    )
  `);

  // CFG-004 Casdoor 字段映射编辑态草稿（全局单例；发布产物在 config_roots/versions）
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.config_field_mapping_state (
      id                   text PRIMARY KEY CHECK (id = 'singleton'),
      entries              jsonb       NOT NULL DEFAULT '[]'::jsonb,
      real_data_activated  boolean     NOT NULL DEFAULT false,
      revision_number      bigint      NOT NULL DEFAULT 1,
      updated_by           text        NULL,
      updated_at           timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP TABLE IF EXISTS public.config_field_mapping_state`);
  await runner.query(`DROP TABLE IF EXISTS public.config_versions`);
  await runner.query(`DROP TABLE IF EXISTS public.config_roots`);
  await runner.query(`DROP TABLE IF EXISTS public.config_club_cohorts`);
  await runner.query(`DROP TABLE IF EXISTS public.config_academic_year_settings`);
  await runner.query(`DROP TABLE IF EXISTS public.config_scoped_policy_table`);
  await runner.query(`DROP TABLE IF EXISTS public.config_club_profiles`);
}
