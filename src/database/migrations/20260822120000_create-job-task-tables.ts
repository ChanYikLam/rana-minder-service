/**
 * 迁移：后台任务持久表（后台任务与批量编排模块，ADR-004 / ADR-014）。
 *
 * 版本：20260822120000
 * 归属模块：后台任务与批量编排（platform/tasks；ADR-002 §2.2，ADR-004）
 * 权威来源：docs/architecture/ADR-004-后台任务与可靠投递机制.md（§2.4 实现约束）、
 * docs/specification/数据模型与约束-v1.0.md（DATA-JOB-001/002/003、DATA-CON-006、DATA-Q-004）、
 * docs/specification/安全设计与实现级威胁模型-v1.0.md（SEC-VER-011：旧租约/重复领取/租约过期迟到提交不得提交业务结果）。
 *
 * 约束：
 * - 仅用于受控开发/测试环境（GOV-CODE-WAIVER-001 边界）；生产 DDL 门保持关闭。
 * - 迁移文件导出 up()/down()；版本登记表 _migration_log（version, applied_at, checksum）。
 * - 通用任务执行信封（DATA-Q-004 / DATA-JOB-001）：本表保存任务类型/版本、来源模块、
 *   作用域、业务命令 UUID(intent)、调度、租约、技术状态、尝试、幂等与脱敏执行结果；
 *   模块拥有的强类型意图/结果表保存专项业务数据，本表不得复制业务正文。
 * - 表结构与 postgres-task.repository.ts 逐列对齐（评审要求迁移与仓储单源一致）。
 * - 租约字段（lease_worker_id/lease_version/lease_until/leased_at）由原子条件更新维护；
 *   领取/续租/完成/过期重领的原子语义在仓储 SQL 中实现，旧租约令牌提交必须失败（SEC-VER-011）。
 */

/** 与具体迁移工具解耦的最小查询执行器（工具选型见 DEP-Q-001，未冻结） */
export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

const TASK_STATUSES = `('PENDING','LEASED','RETRYABLE_FAILED','UNCERTAIN','MANUAL_INTERVENTION','COMPLETED')`;
const TASK_TYPES = `('CASDOOR_SYNC','CASDOOR_GROUP_WRITE','NOTIFICATION_DELIVERY','FILE_CHECK','EXPORT_GENERATION','DEADLINE','FORMAL_DELETE','DERIVED_REBUILD','RECONCILIATION','BATCH_EXECUTION')`;

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.job_tasks (
      task_id           text        PRIMARY KEY,
      task_type         text        NOT NULL,
      status            text        NOT NULL,
      intent_id         text        NOT NULL,
      idempotency_key   text        NOT NULL,
      scope             jsonb       NOT NULL,
      source            jsonb       NOT NULL,
      payload           jsonb       NOT NULL DEFAULT '{}'::jsonb,
      lease_worker_id   text        NULL,
      lease_version     bigint      NULL,
      lease_until       timestamptz NULL,
      leased_at         timestamptz NULL,
      attempts          integer     NOT NULL DEFAULT 0,
      max_attempts      integer     NOT NULL,
      not_before        timestamptz NOT NULL,
      failure           jsonb       NULL,
      result_ref        text        NULL,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_job_tasks_status CHECK (status IN ${TASK_STATUSES}),
      CONSTRAINT ck_job_tasks_type CHECK (task_type IN ${TASK_TYPES}),
      CONSTRAINT ck_job_tasks_attempts_nonneg CHECK (attempts >= 0),
      CONSTRAINT ck_job_tasks_max_attempts_pos CHECK (max_attempts > 0),
      CONSTRAINT ck_job_tasks_lease_consistency CHECK (
        (lease_worker_id IS NULL AND lease_version IS NULL AND lease_until IS NULL AND leased_at IS NULL) OR
        (lease_worker_id IS NOT NULL AND lease_version IS NOT NULL AND lease_until IS NOT NULL AND leased_at IS NOT NULL)
      )
    )
  `);

  // 幂等去重：同一业务意图/幂等键最多存在一条任务（DATA-JOB-001、DATA-CON-003）
  await runner.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_job_tasks_intent_id
      ON public.job_tasks (intent_id)
  `);
  await runner.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_job_tasks_idempotency_key
      ON public.job_tasks (idempotency_key)
  `);

  // 到期领取/截止任务扫描：状态 + 可执行时间（DATA-CON-006 领取与积压公平性）
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_job_tasks_due
      ON public.job_tasks (status, not_before)
  `);

  // 租约过期重领扫描：执行中 + 租约到期（SEC-VER-011 过期重领）
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_job_tasks_lease_expired
      ON public.job_tasks (status, lease_until)
      WHERE status = 'LEASED' AND lease_until IS NOT NULL
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP TABLE IF EXISTS public.job_tasks`);
}
