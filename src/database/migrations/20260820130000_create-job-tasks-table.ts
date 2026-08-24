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
 *
 * 兼容说明（2026-08-23）：
 * `public.job_tasks` 表现已由 platform/tasks 模块的迁移
 * `20260822120000_create-job-task-tables` 以「通用任务执行信封」口径接管
 * （ADR-004 §2.4 / DATA-JOB-001），表结构以该迁移为准逐列对齐
 * `postgres-task-repository.ts`。本迁移作为历史版本保留并登记版本号，
 * 不再创建旧口径的 job_tasks 表，避免与后继迁移在同一表上以不兼容的
 * schema 冲突（此前会导致 `uq_job_tasks_intent_id` 索引因缺少 intent_id
 * 列而失败，OPS-UPG-002 顺序迁移要求）。
 *
 * 注意：job 模块旧版 PostgresJobTaskStore 为被 platform/tasks 取代前的
 * 遗留实现，其旧表字段已不再维护；运行期数据访问以新迁移为准。
 *
 * 旧表处置 / 升级路径（OPS-UPG-002 显式声明）：
 * 若既有部署在 20260822120000 之前已按本迁移旧口径建过 public.job_tasks
 * （旧 schema：id/kind/ref_id/schedule_type/at/lease_holder 等，无 intent_id），
 * 本迁移改无操作后该旧表**不会被本迁移 drop，也不会被 20260822120000
 * 接管**（新迁移要求 intent_id 等列）。升级到通用任务信封口径前须执行
 * 一次性处置，二选一并登记：
 *   (a) 无存量任务（骨架/开发环境默认）：直接
 *       DROP TABLE IF EXISTS public.job_tasks;   —— 旧表为遗留实现、无数据
 *           时首选；新迁移随后按新 schema 建表。
 *   (b) 有需保留的存量任务（生产升级场景）：先核对 pg_attribute 确认旧
 *       schema，再手动重映射/搬迁到 20260822120000 的 job_tasks 列形态后
 *       移交，随后由 20260822120000 的 up() 正常接管；不得在同表上同时
 *       并存两套 schema（避免 uq_job_tasks_intent_id 等索引缺列失败）。
 * 判定：`SELECT column_name FROM information_schema.columns WHERE
 *        table_name='job_tasks' AND column_name IN ('intent_id','lease_until');`
 *        有 intent_id → 新口径已建，无需处置；否则按 (a)/(b) 处置。
 */

import type { MigrationQueryRunner } from './20260820100000_create-identity-tables';

export async function up(runner: MigrationQueryRunner): Promise<void> {
  // fail-fast 防线（评审 warning）：本迁移改无操作后，若既有部署仍残留旧口径
  // job_tasks（缺 intent_id 列），后继 20260822120000 会因 uq_job_tasks_intent_id
  // 索引缺列直接失败、升级中断。此处先行探测并在升级中断前抛出明确处置指引，
  // 阻断"旧表被静默绕过 → 后继迁移炸"的破坏性路径（OPS-UPG-002 显式声明）。
  const result = (await runner.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'job_tasks') AS has_table,
            EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'job_tasks'
          AND column_name = 'intent_id') AS has_intent`,
  )) as { rows?: unknown[] } | Array<{ has_table?: unknown; has_intent?: unknown }> | null;
  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: Array<{ has_table?: unknown; has_intent?: unknown }> } | null)
        ?.rows ?? []);
  const row = rows[0] as { has_table?: unknown; has_intent?: unknown } | undefined;
  const truthy = (v: unknown): boolean => v === true || v === 't' || v === 1 || v === '1';
  const hasTable = truthy(row?.has_table);
  const hasIntent = truthy(row?.has_intent);
  if (hasTable && !hasIntent) {
    throw new Error(
      'job_tasks 为旧口径（缺 intent_id 列），升级前须按 OPS-UPG-002 处置：' +
        '无存量任务直接 DROP TABLE IF EXISTS public.job_tasks；' +
        '有存量任务先手动重映射到新列形态后移交。' +
        '详见 20260820130000_create-job-tasks-table.ts 头注释「旧表处置 / 升级路径」。',
    );
  }
  // 无操作：job_tasks 由 20260822120000_create-job-task-tables 统一接管。
}

export async function down(_runner: MigrationQueryRunner): Promise<void> {
  // 无操作：表归属 20260822120000，其 down() 负责移除 job_tasks。
}
