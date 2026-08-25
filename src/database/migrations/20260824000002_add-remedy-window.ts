/**
 * 迁移：补救窗口记录表（recruitment；REC-003/REC-006/009/038/REC-044）。
 *
 * 版本：20260824000002
 * 归属模块：recruitment
 * 说明：CreateRemedyWindowUseCase 此前为「瞬时副作用」（windowId/deadline 未落库，
 * 无法审计与追踪）。新增 remedy_windows 表持久化每次开窗记录（不可变事件）。
 * 目标申请集合入 JSONB 数组（与建表迁移的数组类字段一致）。
 */

/** 与具体迁移工具解耦的最小查询执行器（工具选型见 DEP-Q-001，未冻结） */
export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.remedy_windows (
      window_id             text        PRIMARY KEY,
      activity_id           text        NOT NULL REFERENCES public.recruitment_activities (id),
      kind                  text        NOT NULL,
      target_application_ids jsonb      NOT NULL DEFAULT '[]'::jsonb,
      deadline              timestamptz NOT NULL,
      reason                text        NOT NULL,
      created_by            text        NOT NULL,
      created_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_remedy_windows_kind
        CHECK (kind IN ('RULE_TIGHTENING','PERSONAL_RECOVERY','IDENTITY_ANOMALY'))
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_remedy_windows_activity
      ON public.remedy_windows (activity_id)
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP TABLE IF EXISTS public.remedy_windows`);
}
