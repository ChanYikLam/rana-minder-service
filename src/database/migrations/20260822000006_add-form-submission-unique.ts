/**
 * 迁移：form_submissions 补 (form_id, version_number, submitted_by) 唯一约束（form 域，4.4 评审修复）。
 *
 * 版本：20260822000006
 * 背景：submit-form 应用层以 loadBySubmitter 前置检查"同一提交者对同一版本仅一份提交"，
 * 但 DB 层无唯一约束兜底，无幂等键的并发提交存在竞态窗口，可能插入重复提交记录。
 * 补唯一约束后，并发重复提交经 ON CONFLICT (form_id, version_number, submitted_by)
 * 由仓储映射为 409 资源争用，杜绝重复记录。
 *
 * 约束：仅受控开发/测试环境；生产 DDL 门保持关闭（GOV-CODE-WAIVER-001）。
 */

export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(
    `ALTER TABLE public.form_submissions
       DROP CONSTRAINT IF EXISTS uq_form_submissions_form_version_submitter`,
  );
  await runner.query(
    `ALTER TABLE public.form_submissions
       ADD CONSTRAINT uq_form_submissions_form_version_submitter
       UNIQUE (form_id, version_number, submitted_by)`,
  );
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(
    `ALTER TABLE public.form_submissions
       DROP CONSTRAINT IF EXISTS uq_form_submissions_form_version_submitter`,
  );
}
