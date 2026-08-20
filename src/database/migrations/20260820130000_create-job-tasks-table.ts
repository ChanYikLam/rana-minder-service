/**
 * 迁移：持久任务表族（job 模块；ADR-004 租约执行单元）。
 *
 * 版本：20260820130000
 * 归属模块：job（与业务意图同库同事务登记，见 identity/infrastructure
 * profile-sync-task.writer.ts）
 *
 * 语义（ADR-004）：
 * - id 为幂等去重键（<type>:<subject>:<field>:<version> 或
 *   name-correction:<subject>:<requestId>），ON CONFLICT DO NOTHING；
 * - status：pending / running / done / failed；结算仅限 running（持租约者）；
 * - 领取 = 单条 UPDATE ... RETURNING 原子单胜者，过期租约可再次领取；
 * - payload 只携带稳定引用，不携带敏感正文（CAS-WR-002/003）。
 */

import type { MigrationQueryRunner } from './20260820100000_create-identity-tables';

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.job_tasks (
      id               text        PRIMARY KEY,
      type             text        NOT NULL,
      subject_id       text        NOT NULL,
      payload          jsonb       NOT NULL,
      status           text        NOT NULL DEFAULT 'pending',
      attempts         integer     NOT NULL DEFAULT 0,
      next_run_at      timestamptz NULL,
      leased_until     timestamptz NULL,
      last_attempt_at  timestamptz NULL,
      claimed_at       timestamptz NULL,
      completed_at     timestamptz NULL,
      failed_at        timestamptz NULL,
      error            text        NULL,
      created_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_job_task_status CHECK (status IN
        ('pending', 'running', 'done', 'failed')),
      CONSTRAINT ck_job_task_attempts CHECK (attempts >= 0)
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_job_tasks_claim
      ON public.job_tasks (status, next_run_at, created_at, id)
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP TABLE IF EXISTS public.job_tasks`);
}