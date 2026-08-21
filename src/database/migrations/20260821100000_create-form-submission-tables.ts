/**
 * 迁移：动态表单提交与修订（form 域，FORM-002 4.1.2）
 *
 * 版本：20260821100000
 * 归属模块：form（ADR-002 §2.1；FORM-002）
 * 权威来源：docs/requirements/07-动态表单与附件需求发现记录.md（FORM-002）、
 * docs/specification/数据模型与约束-v1.0.md（DATA-FRM-001~003）。
 *
 * 约束：
 * - 仅受控开发/测试环境；生产 DDL 门保持关闭（GOV-CODE-WAIVER-001）。
 * - 与 postgres-form-submission.repository.ts 逐列对齐（迁移与仓储单源一致）。
 * - 提交记录固定业务骨架列（id/作用域/提交者/版本/状态/修订号/时间），动态答案与
 *   修订历史仅入 form_submissions.values / revisions JSONB（ADR-006、DATA-FRM-001）；
 *   已提交记录修订以修订号乐观守卫（IFC-GEN-007）。
 */

export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.form_submissions (
      id             text        PRIMARY KEY,
      form_id        text        NOT NULL REFERENCES public.form_definitions (id),
      version_number bigint      NOT NULL,
      scope          text        NOT NULL,
      owner_id       text        NULL,
      submitted_by   text        NOT NULL,
      values         jsonb       NOT NULL DEFAULT '{}'::jsonb,
      status         text        NOT NULL,
      revision_number bigint      NOT NULL DEFAULT 1,
      revisions      jsonb       NOT NULL DEFAULT '[]'::jsonb,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_form_submissions_scope CHECK (scope IN ('platform', 'club', 'department')),
      CONSTRAINT ck_form_submissions_status CHECK (status IN ('DRAFT', 'SUBMITTED')),
      CONSTRAINT ck_form_submissions_number_positive CHECK (version_number > 0),
      CONSTRAINT ck_form_submissions_owner CHECK (
        (scope = 'platform' AND owner_id IS NULL) OR
        (scope <> 'platform' AND owner_id IS NOT NULL)
      )
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_form_submissions_scope_owner
      ON public.form_submissions (scope, owner_id)
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_form_submissions_form_version
      ON public.form_submissions (form_id, version_number)
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP TABLE IF EXISTS public.form_submissions`);
}
