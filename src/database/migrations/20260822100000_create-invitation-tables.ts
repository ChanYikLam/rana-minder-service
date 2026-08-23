/**
 * 迁移：邀请与成员激活（invitation 域，SRS-SM-INV-001 / SRS-SM-MEM-004）
 *
 * 版本：20260822100000
 * 归属模块：invitation（ADR-002 §2.1）
 * 权威来源：docs/requirements/09-邀请与成员激活需求发现记录.md（REC-024~028、MEM-018）、
 * docs/specification/数据模型与约束-v1.0.md、ADR-006（关系骨架＋JSONB）、
 * ADR-014（单数据库统一应用业务 Schema）。
 *
 * 约束：
 * - 本迁移仅用于受控开发/测试环境（GOV-CODE-WAIVER-001 边界）；生产 DDL 门保持关闭。
 * - 迁移文件导出 up()/down()；版本登记表 _migration_log（version, applied_at, checksum）。
 * - 邀请内容固定骨架强类型列；激活意图与不可变历史入 JSONB（ADR-006）。
 *   表结构与 postgres-invitation.repository.ts 逐列对齐（迁移与仓储单源一致）。
 * - 待处理唯一性：`(club_id, invitee_id) WHERE status='PENDING'` 部分唯一索引
 *   （MEM-018 同社团同对象最多一份待处理；仓储 save 同步校验，双保险）。
 * - 常规入社邀请独立表 routine_invitations（强类型对象不混批，SRS-SM-INV-001）。
 */

/** 与具体迁移工具解耦的最小查询执行器（工具选型见 DEP-Q-001，未冻结） */
export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.invitations (
      invitation_id     text        PRIMARY KEY,
      kind              text        NOT NULL,
      invitee_id        text        NOT NULL,
      club_id           text        NOT NULL,
      issuer_id         text        NOT NULL,
      decision_ref      text        NULL,
      reissued_from_id  text        NULL,
      status            text        NOT NULL,
      version           bigint      NOT NULL DEFAULT 0,
      created_at        timestamptz NOT NULL DEFAULT now(),
      expires_at        timestamptz NOT NULL,
      accepted_at       timestamptz NULL,
      activation_json   jsonb       NULL,
      history_json      jsonb       NOT NULL DEFAULT '[]'::jsonb
    )
  `);
  await runner.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS invitations_pending_unique
      ON public.invitations (club_id, invitee_id)
      WHERE status = 'PENDING'
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS invitations_invitee_idx
      ON public.invitations (invitee_id, status)
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.routine_invitations (
      routine_invitation_id text        PRIMARY KEY,
      invitee_id            text        NOT NULL,
      club_id               text        NOT NULL,
      department_id         text        NULL,
      issuer_id             text        NOT NULL,
      status                text        NOT NULL,
      version               bigint      NOT NULL DEFAULT 0,
      created_at            timestamptz NOT NULL DEFAULT now(),
      expires_at            timestamptz NOT NULL,
      accepted_at           timestamptz NULL,
      activated_at          timestamptz NULL,
      relation_targets      jsonb       NOT NULL DEFAULT '[]'::jsonb,
      sync_status           jsonb       NULL,
      attempt_count         int         NOT NULL DEFAULT 0,
      last_error            text        NULL,
      history_json          jsonb       NOT NULL DEFAULT '[]'::jsonb
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS routine_invitations_invitee_idx
      ON public.routine_invitations (invitee_id, status)
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP INDEX IF EXISTS public.routine_invitations_invitee_idx`);
  await runner.query(`DROP TABLE IF EXISTS public.routine_invitations`);
  await runner.query(`DROP INDEX IF EXISTS public.invitations_invitee_idx`);
  await runner.query(`DROP INDEX IF EXISTS public.invitations_pending_unique`);
  await runner.query(`DROP TABLE IF EXISTS public.invitations`);
}
