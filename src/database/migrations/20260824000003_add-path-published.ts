/**
 * 迁移：部门考察路径结果发布标记（recruitment；REC-004/REC-024 结果发布持久化）。
 *
 * 版本：20260824000003
 * 归属模块：recruitment
 * 说明：PublishPathResultUseCase 此前仅校验并返回 published:true，未落库「已发布」态，
 * 调用方无法区分已发布/未发布、无法审计。新增 department_paths.published 标记，
 * 发布动作落库（幂等：可修改重发布，归档后仅纠错由上层判定——REC-024）。
 */

/** 与具体迁移工具解耦的最小查询执行器（工具选型见 DEP-Q-001，未冻结） */
export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(
    `ALTER TABLE public.department_paths ADD COLUMN IF NOT EXISTS published boolean NOT NULL DEFAULT false`,
  );
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`ALTER TABLE public.department_paths DROP COLUMN IF EXISTS published`);
}
