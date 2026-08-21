/**
 * 迁移：interview_records / department_paths 修订号列改为 bigint，并补部门路径唯一约束
 * （recruitment 域，4.4 评审修复）。
 *
 * 版本：20260822000004
 * 背景：
 * - 评审 #3：0002 将 revision_number 加为 text，与 applications/form_submissions 的 bigint
 *   不一致，文本比较无法走索引且排序语义错误。此处统一为 bigint。
 * - 评审 #2：department_paths 对 (application_id, department_id) 无唯一约束，并发对同一部门
 *   建路径会重复插入。补唯一约束（配合 record-department-decision 使用稳定 path id，使并发
 *   单胜者通过 ON CONFLICT (id) 命中而冲突）。
 *
 * 约束：仅受控开发/测试环境；生产 DDL 门保持关闭（GOV-CODE-WAIVER-001）。
 */

export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(
    `ALTER TABLE public.interview_records ALTER COLUMN revision_number TYPE bigint USING revision_number::bigint`,
  );
  await runner.query(
    `ALTER TABLE public.department_paths ALTER COLUMN revision_number TYPE bigint USING revision_number::bigint`,
  );
  await runner.query(
    `ALTER TABLE public.department_paths ADD CONSTRAINT uq_department_paths_application_department
     UNIQUE (application_id, department_id)`,
  );
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(
    `ALTER TABLE public.department_paths DROP CONSTRAINT IF EXISTS uq_department_paths_application_department`,
  );
  await runner.query(
    `ALTER TABLE public.department_paths ALTER COLUMN revision_number TYPE text USING revision_number::text`,
  );
  await runner.query(
    `ALTER TABLE public.interview_records ALTER COLUMN revision_number TYPE text USING revision_number::text`,
  );
}
