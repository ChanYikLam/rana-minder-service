/**
 * 迁移：interview_records / department_paths 增加 revision_number 乐观锁列（recruitment 域，4.4 评审修复）。
 *
 * 版本：20260822000002
 * 背景：评审指出 save* 无乐观守卫，并发更新/评价追加存在覆盖丢失风险。Application
 * 已有 revision_number；Interview / DepartmentPath 补充该列以支持 WHERE revision_number 守卫。
 *
 * 约束：仅受控开发/测试环境；生产 DDL 门保持关闭（GOV-CODE-WAIVER-001）。
 */

export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(
    `ALTER TABLE public.interview_records ADD COLUMN revision_number bigint NOT NULL DEFAULT 0`,
  );
  await runner.query(
    `ALTER TABLE public.department_paths ADD COLUMN revision_number bigint NOT NULL DEFAULT 0`,
  );
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`ALTER TABLE public.interview_records DROP COLUMN IF EXISTS revision_number`);
  await runner.query(`ALTER TABLE public.department_paths DROP COLUMN IF EXISTS revision_number`);
}
