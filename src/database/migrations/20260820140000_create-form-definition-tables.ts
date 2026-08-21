/**
 * 迁移：动态表单定义与版本（form 域，SRS-SM-FORM-001 4.1.1）
 *
 * 版本：20260820140000
 * 归属模块：form（ADR-002 §2.1；SRS-SM-FORM-001）
 * 权威来源：docs/requirements/07-动态表单与附件需求发现记录.md（FORM-001/002/003/004/005/010）、
 * docs/specification/数据模型与约束-v1.0.md（DATA-FRM-001~003）、ADR-006（关系骨架＋JSONB）、
 * ADR-014（单数据库统一应用业务 Schema）。
 *
 * 约束：
 * - 本迁移仅用于受控开发/测试环境（GOV-CODE-WAIVER-001 边界）；生产 DDL 门保持关闭。
 * - 迁移文件导出 up()/down()；版本登记表 _migration_log（version, applied_at, checksum）。
 * - 固定业务骨架强类型列（根/版本/状态/指针/时间/操作者），动态字段只入
 *   form_versions.fields JSONB（ADR-006、DATA-FRM-001）：已发布/已停用版本内容不可更新，
 *   复用必须建新草稿并发布新版本（SRS-INV-011、PRD-OPT-043）。
 * - 表结构与 postgres-form-definition.repository.ts 逐列对齐（评审要求迁移与仓储单源一致）：
 *   form_definitions / form_versions / form_preview_tests / form_template_publications /
 *   form_audit / form_idempotency。
 */

/** 与具体迁移工具解耦的最小查询执行器（工具选型见 DEP-Q-001，未冻结） */
export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.form_definitions (
      id                        text        PRIMARY KEY,
      scope                     text        NOT NULL,
      owner_id                  text        NULL,
      kind                      text        NOT NULL,
      title                     text        NOT NULL,
      description               text        NULL,
      business_family           text        NULL,
      current_draft_version     bigint      NULL,
      current_published_version bigint      NULL,
      version                   bigint      NOT NULL DEFAULT 0,
      created_by                text        NOT NULL,
      created_at                timestamptz NOT NULL DEFAULT now(),
      updated_at                timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_form_definitions_scope CHECK (scope IN ('platform', 'club', 'department')),
      CONSTRAINT ck_form_definitions_kind CHECK (kind IN ('FORM', 'TEMPLATE')),
      CONSTRAINT ck_form_definitions_owner CHECK (
        (scope = 'platform' AND owner_id IS NULL) OR
        (scope <> 'platform' AND owner_id IS NOT NULL)
      )
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_form_definitions_scope_owner
      ON public.form_definitions (scope, owner_id)
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.form_versions (
      id               text        PRIMARY KEY,
      form_id          text        NOT NULL REFERENCES public.form_definitions (id),
      version_number   bigint      NOT NULL,
      status           text        NOT NULL,
      publishable      boolean     NOT NULL DEFAULT false,
      fields           jsonb       NOT NULL DEFAULT '[]'::jsonb,
      source_form_id   text        NULL,
      source_version   bigint      NULL,
      published_at     timestamptz NULL,
      published_by     text        NULL,
      deprecated_at    timestamptz NULL,
      deprecated_by    text        NULL,
      created_by       text        NOT NULL,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_form_versions_form_number UNIQUE (form_id, version_number),
      CONSTRAINT ck_form_versions_status CHECK (status IN
        ('DRAFT', 'PREVIEW_TESTING', 'PUBLISHED', 'DEPRECATED')),
      CONSTRAINT ck_form_versions_number_positive CHECK (version_number > 0),
      CONSTRAINT ck_form_versions_publishable CHECK (
        (status = 'DRAFT' AND publishable IN (true, false)) OR
        (status <> 'DRAFT' AND publishable = false)
      )
    )
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.form_preview_tests (
      id             text        PRIMARY KEY,
      form_id        text        NOT NULL REFERENCES public.form_definitions (id),
      version_number bigint      NOT NULL,
      result         text        NOT NULL,
      summary        jsonb       NOT NULL DEFAULT '{}'::jsonb,
      tested_by      text        NOT NULL,
      tested_at      timestamptz NOT NULL,
      CONSTRAINT uq_form_preview_tests_form_version UNIQUE (form_id, version_number),
      CONSTRAINT ck_form_preview_tests_result CHECK (result IN ('PASSED', 'FAILED'))
    )
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.form_template_publications (
      id               text        PRIMARY KEY,
      form_id          text        NOT NULL REFERENCES public.form_definitions (id),
      source_version   bigint      NOT NULL,
      status           text        NOT NULL DEFAULT 'PENDING',
      note             text        NULL,
      requested_by     text        NOT NULL,
      requested_at     timestamptz NOT NULL,
      decided_by       text        NULL,
      decided_at       timestamptz NULL,
      decision_reason  text        NULL,
      template_form_id text        NULL,
      version          bigint      NOT NULL DEFAULT 0,
      CONSTRAINT ck_form_template_publications_status CHECK (status IN
        ('PENDING', 'APPROVED', 'REJECTED'))
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_form_template_publications_status
      ON public.form_template_publications (status)
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.form_audit (
      id          text        PRIMARY KEY,
      type        text        NOT NULL,
      subject_id  text        NOT NULL,
      occurred_at timestamptz NOT NULL,
      actor       text        NOT NULL,
      summary     jsonb       NOT NULL,
      trace_id    text        NULL
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_form_audit_subject
      ON public.form_audit (subject_id, occurred_at)
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.form_idempotency (
      scope_key       text        NOT NULL,
      idempotency_key text        NOT NULL,
      semantic_hash   text        NOT NULL,
      result          jsonb       NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (scope_key, idempotency_key)
    )
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP TABLE IF EXISTS public.form_idempotency`);
  await runner.query(`DROP TABLE IF EXISTS public.form_audit`);
  await runner.query(`DROP TABLE IF EXISTS public.form_template_publications`);
  await runner.query(`DROP TABLE IF EXISTS public.form_preview_tests`);
  await runner.query(`DROP TABLE IF EXISTS public.form_versions`);
  await runner.query(`DROP TABLE IF EXISTS public.form_definitions`);
}
