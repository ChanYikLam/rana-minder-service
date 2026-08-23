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
 */

import type { MigrationQueryRunner } from './20260820100000_create-identity-tables';

export async function up(_runner: MigrationQueryRunner): Promise<void> {
  // 无操作：job_tasks 由 20260822120000_create-job-task-tables 统一接管。
}

export async function down(_runner: MigrationQueryRunner): Promise<void> {
  // 无操作：表归属 20260822120000，其 down() 负责移除 job_tasks。
}
