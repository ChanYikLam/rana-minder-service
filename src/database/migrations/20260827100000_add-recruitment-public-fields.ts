/**
 * 迁移：招新活动公开报名视图列（recruitment；联调 2026-08-27）。
 *
 * 版本：20260827100000
 * 归属模块：recruitment
 * 说明：申请人端公开读视图（GET /api/explore/activities/:id）需要
 * 部门列表 / 是否服从调剂默认值 / 绑定表单 id；此前仅存在于 mock 层，
 * 落库到 recruitment_activities（上游客收后并入正式契约迁移）。
 */

/** 与具体迁移工具解耦的最小查询执行器（工具选型见 DEP-Q-001，未冻结） */
export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(
    `ALTER TABLE public.recruitment_activities ADD COLUMN IF NOT EXISTS departments jsonb NOT NULL DEFAULT '[]'`,
  );
  await runner.query(
    `ALTER TABLE public.recruitment_activities ADD COLUMN IF NOT EXISTS allow_adjustment_default boolean NOT NULL DEFAULT true`,
  );
  await runner.query(
    `ALTER TABLE public.recruitment_activities ADD COLUMN IF NOT EXISTS form_id text NULL`,
  );
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`ALTER TABLE public.recruitment_activities DROP COLUMN IF EXISTS departments`);
  await runner.query(
    `ALTER TABLE public.recruitment_activities DROP COLUMN IF EXISTS allow_adjustment_default`,
  );
  await runner.query(`ALTER TABLE public.recruitment_activities DROP COLUMN IF EXISTS form_id`);
}
