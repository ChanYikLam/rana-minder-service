/**
 * 迁移：报名提交幂等结果存储（recruitment；B2 幂等键重放）。
 *
 * 版本：20260828120000
 * 归属模块：recruitment
 * 说明：同一 idempotency_key 的提交重放须返回原结果（API-GEN 幂等契约），
 * 而非"已存在申请"冲突错误。提交成功后以 key 落回执；重放时直接返回原 data。
 * scope 预留同键跨用途隔离（当前仅 'submit-application'）。
 */

/** 与具体迁移工具解耦的最小查询执行器（工具选型见 DEP-Q-001，未冻结） */
export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.recruitment_idempotency (
      idempotency_key text        PRIMARY KEY,
      scope           text        NOT NULL,
      result          jsonb       NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP TABLE IF EXISTS public.recruitment_idempotency`);
}
