/**
 * 迁移：报名通道新窗口截止列（recruitment；SRS-SM-REC-002 重开新窗口截止持久化）。
 *
 * 版本：20260824000000
 * 归属模块：recruitment
 * 说明：重开新窗口（CLOSED → OPEN）须携新截止且严格晚于重开时刻；
 * 新截止持久化到 application_channel.deadline（报名用例按窗口截止校验）。
 * 首次开放截止为 null（截止由活动层控制）。
 */

/** 与具体迁移工具解耦的最小查询执行器（工具选型见 DEP-Q-001，未冻结） */
export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(
    `ALTER TABLE public.application_channel ADD COLUMN IF NOT EXISTS deadline timestamptz NULL`,
  );
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`ALTER TABLE public.application_channel DROP COLUMN IF EXISTS deadline`);
}
