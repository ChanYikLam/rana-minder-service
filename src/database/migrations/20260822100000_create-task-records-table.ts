/**
 * 迁移：平台任务信封持久表（platform/tasks；ADR-004 租约执行单元）。
 *
 * 版本：20260822100000
 * 归属模块：platform/tasks（TASK_REPOSITORY 的 PostgreSQL 实现；与领域业务意图
 * 同库同事务登记，ADR-014 单数据库统一应用业务 Schema）。
 *
 * 语义（ADR-004 §2 / DATA-CON-006 / SEC-VER-011）：
 * - task_id 为主键（<intentId>:<taskType> 派生的追踪号）；
 * - intent_id / idempotency_key 唯一约束，保证业务意图与幂等键去重；
 * - status：PENDING / LEASED / RETRYABLE_FAILED / UNCERTAIN /
 *   MANUAL_INTERVENTION / COMPLETED；
 * - 领取 = 单条 UPDATE ... RETURNING 原子单胜者（排除终态 + 有效租约占用 +
 *   到期可执行）；租约到期可重领；
 * - 完成/收口带 lease_version 守卫，旧租约令牌提交必须失败（SEC-VER-011）；
 * - payload 只携带稳定引用，不携带敏感正文（CAS-WR-002/003）。
 */

import type { MigrationQueryRunner } from './20260820100000_create-identity-tables';

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.task_records (
      task_id           text        PRIMARY KEY,
      task_type         text        NOT NULL,
      status            text        NOT NULL DEFAULT 'PENDING',
      intent_id         text        NOT NULL,
      idempotency_key   text        NOT NULL,
      scope             jsonb       NOT NULL DEFAULT '{}'::jsonb,
      source            jsonb       NOT NULL DEFAULT '{}'::jsonb,
      payload           jsonb       NOT NULL DEFAULT '{}'::jsonb,
      lease             jsonb       NULL,
      attempts          integer     NOT NULL DEFAULT 0,
      max_attempts      integer     NOT NULL DEFAULT 5,
      not_before        timestamptz NOT NULL DEFAULT now(),
      failure           jsonb       NULL,
      result_ref        text        NULL,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_task_records_status CHECK (status IN
        ('PENDING', 'LEASED', 'RETRYABLE_FAILED', 'UNCERTAIN',
         'MANUAL_INTERVENTION', 'COMPLETED')),
      CONSTRAINT uq_task_records_intent UNIQUE (intent_id),
      CONSTRAINT uq_task_records_idempotency UNIQUE (idempotency_key)
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_task_records_claim
      ON public.task_records (status, not_before, created_at, task_id)
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_task_records_lease_expiry
      ON public.task_records (status, lease)
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP TABLE IF EXISTS public.task_records`);
}
