/**
 * 迁移：组织与授权（organization）聚合表族（#68 / ORG-001~004 接 PG）
 *
 * 版本：20260824000004
 * 归属模块：organization
 * 权威来源：ADR-014（单数据库统一应用业务 Schema）、ADR-005（RLS）、
 * SRS-SM-ORG-001~004、docs/specification/数据模型与约束-v1.0.md。
 *
 * 约束：
 * - 聚合以 jsonb payload 整体存储；查询/守卫字段提升为真实列，支撑索引与
 *   仓储层乐观锁 CAS（club.version / relation.attempt_count /
 *   appointment.schedule_version），语义与内存桩逐一对照。
 * - relation_command.in_flight 由仓储按状态派生维护
 *   （pending_execution/processing/processing_compensating），
 *   支撑"同一目标处理中禁止并发冲突操作"的 O(1) 索引查询。
 * - group_mapping 用显式列（owner/name 唯一）承载稳定映射与对账；
 *   position_template_binding 以 (owner,name) 唯一（一个职位 Group 同一时刻至多一个绑定，GOV-007）。
 * - RLS：本批表为组织域管理面数据，首版统一 unprotected 上下文，社团级行隔离由
 *   仓储 WHERE club_id 过滤承担；ADR-005 细化随组织层数据隔离任务落地。
 */
import type { MigrationQueryRunner } from './20260820100000_create-identity-tables';

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.org_club_space (
      id                text PRIMARY KEY,
      version           integer NOT NULL,
      club_group_owner  text NULL,
      club_group_name   text NULL,
      payload           jsonb NOT NULL
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_org_club_group
      ON public.org_club_space (club_group_owner, club_group_name)
      WHERE club_group_owner IS NOT NULL
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.org_relation_command (
      id              text PRIMARY KEY,
      attempt_count   integer NOT NULL DEFAULT 0,
      club_id         text    NOT NULL,
      subject_id      text    NOT NULL,
      type            text    NOT NULL,
      idempotency_key text    NOT NULL,
      in_flight       boolean NOT NULL DEFAULT false,
      payload         jsonb   NOT NULL
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_org_rel_idem
      ON public.org_relation_command (idempotency_key, subject_id, type)
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_org_rel_inflight
      ON public.org_relation_command (club_id, subject_id)
      WHERE in_flight = true
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.org_appointment_command (
      id                  text PRIMARY KEY,
      club_id             text NOT NULL,
      schedule_version    integer NOT NULL DEFAULT 0,
      relation_command_id text NULL,
      payload             jsonb NOT NULL
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_org_appt_club
      ON public.org_appointment_command (club_id)
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_org_appt_relation
      ON public.org_appointment_command (relation_command_id)
      WHERE relation_command_id IS NOT NULL
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.org_permission_template (
      id      text PRIMARY KEY,
      payload jsonb NOT NULL
    )
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.org_position_template_binding (
      position_owner text  NOT NULL,
      position_name  text  NOT NULL,
      club_id        text  NOT NULL,
      payload        jsonb NOT NULL,
      PRIMARY KEY (position_owner, position_name)
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_org_binding_club
      ON public.org_position_template_binding (club_id)
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.org_group_mapping (
      group_owner     text NOT NULL,
      group_name      text NOT NULL,
      club_id         text NOT NULL,
      purpose         text NOT NULL,
      department_id   text NULL,
      position_id     text NULL,
      mapping_version integer NOT NULL DEFAULT 1,
      PRIMARY KEY (group_owner, group_name),
      CONSTRAINT ck_org_group_mapping_purpose CHECK (purpose IN ('club','department','position'))
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_org_group_mapping_club
      ON public.org_group_mapping (club_id)
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP INDEX IF EXISTS public.idx_org_group_mapping_club`);
  await runner.query(`DROP TABLE IF EXISTS public.org_group_mapping`);
  await runner.query(`DROP INDEX IF EXISTS public.idx_org_binding_club`);
  await runner.query(`DROP TABLE IF EXISTS public.org_position_template_binding`);
  await runner.query(`DROP TABLE IF EXISTS public.org_permission_template`);
  await runner.query(`DROP INDEX IF EXISTS public.idx_org_appt_relation`);
  await runner.query(`DROP INDEX IF EXISTS public.idx_org_appt_club`);
  await runner.query(`DROP TABLE IF EXISTS public.org_appointment_command`);
  await runner.query(`DROP INDEX IF EXISTS public.idx_org_rel_inflight`);
  await runner.query(`DROP INDEX IF EXISTS public.idx_org_rel_idem`);
  await runner.query(`DROP TABLE IF EXISTS public.org_relation_command`);
  await runner.query(`DROP INDEX IF EXISTS public.idx_org_club_group`);
  await runner.query(`DROP TABLE IF EXISTS public.org_club_space`);
}
