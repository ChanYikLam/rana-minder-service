/**
 * 迁移：后台任务基础设施表（outbox / idempotency / batch）
 *
 * 版本：20260824000000
 * 归属模块：platform/tasks（DATA-JOB-001 持久化补齐；BUG-001 修复）
 * 权威来源：src/platform/tasks 三个内存存储的领域结构，与 Postgres 实现逐列对齐。
 *
 * 约束：
 * - 动态/数组类字段（scope/source/payload/frozenItems/itemResults）入 JSONB；
 * - 表结构与 Postgres*Store 实现保持一致。
 */

export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.task_outbox (
      intent_id     text        PRIMARY KEY,
      task_type     text        NOT NULL,
      idempotency_key text      NOT NULL,
      scope         jsonb       NOT NULL,
      source        jsonb       NOT NULL,
      payload       jsonb       NOT NULL,
      not_before    timestamptz NOT NULL,
      status        text        NOT NULL DEFAULT 'PENDING',
      attempts      bigint      NOT NULL DEFAULT 0,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_task_outbox_status
        CHECK (status IN ('PENDING','FORWARDED','DEAD'))
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_task_outbox_status_created
      ON public.task_outbox (status, created_at)
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.idempotency_records (
      idempotency_key text PRIMARY KEY,
      intent_id       text NOT NULL,
      status          text NOT NULL,
      result_ref      text NULL,
      updated_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_idempotency_records_status
        CHECK (status IN ('EXECUTING','COMPLETED','FAILED'))
    )
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.batch_records (
      batch_id          text        PRIMARY KEY,
      parent_batch_id   text        NULL,
      preview_version   bigint      NOT NULL DEFAULT 0,
      version           bigint      NOT NULL DEFAULT 1,
      status            text        NOT NULL,
      scope             jsonb       NOT NULL,
      operation_type    text        NOT NULL,
      business_type     text        NOT NULL,
      frozen_items      jsonb       NOT NULL DEFAULT '[]'::jsonb,
      item_results      jsonb       NOT NULL DEFAULT '[]'::jsonb,
      created_at        timestamptz NOT NULL DEFAULT now(),
      confirmed_at      timestamptz NULL,
      completed_at      timestamptz NULL
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_batch_records_parent
      ON public.batch_records (parent_batch_id)
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP TABLE IF EXISTS public.batch_records`);
  await runner.query(`DROP TABLE IF EXISTS public.idempotency_records`);
  await runner.query(`DROP TABLE IF EXISTS public.task_outbox`);
}
