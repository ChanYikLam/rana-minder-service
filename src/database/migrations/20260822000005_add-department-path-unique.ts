/**
 * 迁移：department_paths 补 (application_id, department_id) 唯一约束（recruitment 域，4.4 评审修复）。
 *
 * 版本：20260822000005
 * 背景：评审指出并发对同一部门建路径会重复插入。补唯一约束后，配合
 * record-department-decision 的稳定 path id（path:{applicationId}:{departmentId}），
 * 并发单胜者经 ON CONFLICT (id) 命中而冲突。
 * （revision_number 列已在 20260822000002 直接以 bigint 建立，无需二次转换。）
 *
 * 约束：仅受控开发/测试环境；生产 DDL 门保持关闭（GOV-CODE-WAIVER-001）。
 */

export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(
    `ALTER TABLE public.department_paths ADD CONSTRAINT uq_department_paths_application_department
     UNIQUE (application_id, department_id)`,
  );
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(
    `ALTER TABLE public.department_paths DROP CONSTRAINT IF EXISTS uq_department_paths_application_department`,
  );
}
