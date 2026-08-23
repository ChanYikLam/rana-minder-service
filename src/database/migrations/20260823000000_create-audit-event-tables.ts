/**
 * 迁移：业务审计（audit）事件表族（AUD-003/004）
 *
 * 版本：20260823000000
 * 归属模块：audit
 * 权威来源：docs/specification/数据模型与约束-v1.0.md（AUD-003/004）、
 * ADR-014（单数据库统一应用业务 Schema）、SRS-SM-AUD-001。
 *
 * 约束：
 * - 仅用于受控开发/测试环境（GOV-CODE-WAIVER-001 边界）；生产 DDL 门保持关闭。
 * - 审计**只追加、不可篡改**（AUD-003）：应用内不提供修改/删除语句，长期保留。
 * - **敏感不落盘**：密码/邮箱密钥/令牌/验证码/附件正文不得进表；只记脱敏摘要
 *   （由 AuditSanitizer 处理后写入），故敏感字段以 jsonb 摘要形式存放。
 * - 表结构与本模块 postgres-audit-repository 逐列对齐（评审要求迁移与仓储单源一致）。
 * - 查询支持按时间/用户/社团/对象/事件类型过滤，并按 occurred_at 倒序取最近 N 条。
 */
import type { MigrationQueryRunner } from './20260820100000_create-identity-tables';

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.audit_event (
      audit_id        text        PRIMARY KEY,
      event_type      text        NOT NULL,
      actor_id        text        NOT NULL,
      actor_roles     jsonb       NOT NULL DEFAULT '[]'::jsonb,
      scope           jsonb       NULL,
      occurred_at     timestamptz NOT NULL,
      source          jsonb       NULL,
      target          jsonb       NULL,
      old_value       text        NULL,
      new_value       text        NULL,
      outcome         text        NOT NULL,
      failure_reason  text        NULL,
      request_id      text        NOT NULL,
      sanitized_context text      NULL,
      CONSTRAINT ck_audit_event_outcome CHECK (outcome IN
        ('SUCCESS', 'FAILURE', 'DENIED')),
      CONSTRAINT ck_audit_event_type CHECK (event_type IN
        ('AUTH_LOGIN', 'PROFILE_SYNC', 'PERMISSION_CHANGE', 'CLUB_ONBOARDING',
         'RECRUITMENT', 'JOINT_ACTIVITY', 'MEMBERSHIP', 'FORM_SUBMISSION',
         'ATTACHMENT', 'NOTIFICATION', 'MAIL_CREDENTIAL', 'CORRECTION',
         'IMPORT_EXPORT', 'SUPER_ADMIN_OP'))
    )
  `);

  // 审计中心查询索引（AUD-004）：时间倒序取最近 N 条、按操作人/社团/对象/事件类型过滤
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_event_occurred_at
      ON public.audit_event (occurred_at DESC)
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_event_actor
      ON public.audit_event (actor_id, occurred_at DESC)
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_event_club
      ON public.audit_event (((scope->>'clubId')), occurred_at DESC)
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_event_target
      ON public.audit_event (((target->>'objectType')), ((target->>'objectId')), occurred_at DESC)
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_event_type
      ON public.audit_event (event_type, occurred_at DESC)
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP INDEX IF EXISTS public.idx_audit_event_type`);
  await runner.query(`DROP INDEX IF EXISTS public.idx_audit_event_target`);
  await runner.query(`DROP INDEX IF EXISTS public.idx_audit_event_club`);
  await runner.query(`DROP INDEX IF EXISTS public.idx_audit_event_actor`);
  await runner.query(`DROP INDEX IF EXISTS public.idx_audit_event_occurred_at`);
  await runner.query(`DROP TABLE IF EXISTS public.audit_event`);
}
