/**
 * 迁移：身份与资料（identity）域表族
 *
 * 版本：20260820100000
 * 归属模块：identity（ADR-002 §2.1；SRS-SM-IDN-001~003）
 * 权威来源：docs/engineering/实体与表清单草案-v1.0.md §3.1、
 * docs/specification/数据模型与约束-v1.0.md（DATA-CAS-002/003、SRS-SM-IDN-001~003）、
 * ADR-014（单数据库统一应用业务 Schema）。
 *
 * 约束：
 * - 本迁移仅用于受控开发/测试环境（GOV-CODE-WAIVER-001 边界）；生产 DDL 门保持关闭。
 * - 迁移文件导出 up()/down()；版本登记表 _migration_log（version, applied_at, checksum）。
 * - 表名/列名 snake_case；主体标识 subject_id 一律 text（与仓储/DbAdapter 契约一致，
 *   3.3 真实 Casdoor 接入前不做 uuid 强约束）；JSONB 字段统一命名。
 * - 业务表置于统一 Schema（ADR-014，Schema 名属实现命名，此处显式限定为 public）。
 * - 外部账号状态以 Casdoor 为权威（IFC-DATA-008）；本地只保存稳定映射、可信观测、
 *   同步意图、冲突快照与不可变历史。
 * - 表结构与 postgres-*.repository.ts 逐列对齐（评审要求迁移与仓储单源一致）：
 *   identity_profiles / profile_sync_intents / email_verification_requests /
 *   account_access / identity_audit；本域不再使用平铺列 profiles 等命名。
 */

/** 与具体迁移工具解耦的最小查询执行器（工具选型见 DEP-Q-001，未冻结） */
export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.users (
      subject_id        text        PRIMARY KEY,
      student_id        text        NOT NULL,
      casdoor_org       text        NOT NULL,
      casdoor_name      text        NOT NULL,
      display_name      text        NOT NULL,
      created_at        timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_users_student_id UNIQUE (student_id),
      CONSTRAINT uq_users_casdoor_binding UNIQUE (casdoor_org, casdoor_name)
    )
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.identity_profiles (
      subject_id     text        PRIMARY KEY REFERENCES public.users (subject_id),
      fields         jsonb       NOT NULL DEFAULT '{}'::jsonb,
      email_verified boolean     NOT NULL DEFAULT false,
      verified_email text        NULL,
      pending_email  text        NULL,
      version        bigint      NOT NULL DEFAULT 0,
      gate_state     text        NOT NULL DEFAULT 'PENDING_COMPLETION',
      restrictions   jsonb       NOT NULL DEFAULT '[]'::jsonb,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_identity_profiles_gate_state CHECK (gate_state IN
        ('PENDING_COMPLETION', 'PENDING_EMAIL_VERIFICATION', 'WRITABLE', 'PARTIALLY_RESTRICTED'))
    )
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.profile_sync_intents (
      subject_id       text        NOT NULL REFERENCES public.users (subject_id),
      field            text        NOT NULL,
      id               text        NOT NULL,
      target_version   bigint      NOT NULL,
      prior_value      text        NULL,
      target_value     text        NOT NULL,
      readback_value   text        NULL,
      state            text        NOT NULL DEFAULT 'PENDING_SYNC',
      conflict_version bigint      NULL,
      attempts         integer     NOT NULL DEFAULT 0,
      retry_at         timestamptz NULL,
      failed_since     timestamptz NULL,
      resolved_at      timestamptz NULL,
      created_at       timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (subject_id, field),
      CONSTRAINT ck_profile_sync_intent_state CHECK (state IN
        ('SYNCED', 'PENDING_SYNC', 'RETRYING', 'PENDING_READBACK_VERIFICATION',
         'ROLLED_BACK', 'CONFLICT_PENDING_USER_CHOICE', 'MANUAL_INTERVENTION'))
    )
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.email_verification_requests (
      id              text        PRIMARY KEY,
      subject_id      text        NOT NULL REFERENCES public.users (subject_id),
      email           text        NOT NULL,
      token_hash      text        NOT NULL,
      expires_at      timestamptz NOT NULL,
      consumed_at     timestamptz NULL,
      request_version bigint      NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_email_verification_version_positive CHECK (request_version > 0)
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_email_verification_requests_subject
      ON public.email_verification_requests (subject_id, request_version)
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.account_access (
      subject_id                   text        PRIMARY KEY REFERENCES public.users (subject_id),
      state                        text        NOT NULL,
      state_version                bigint      NOT NULL DEFAULT 0,
      degraded_since               timestamptz NULL,
      last_trusted_observation_at  timestamptz NOT NULL,
      session_revoke_version       bigint      NOT NULL DEFAULT 0,
      created_at                   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_account_access_state CHECK (state IN
        ('ACTIVE', 'DISABLED', 'DELETED', 'UNVERIFIABLE'))
    )
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.identity_audit (
      id          text        PRIMARY KEY,
      type        text        NOT NULL,
      subject_id  text        NOT NULL,
      occurred_at timestamptz NOT NULL,
      actor       text        NOT NULL,
      summary     jsonb       NOT NULL,
      trace_id    text        NULL
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_identity_audit_subject
      ON public.identity_audit (subject_id, occurred_at)
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP TABLE IF EXISTS public.identity_audit`);
  await runner.query(`DROP TABLE IF EXISTS public.account_access`);
  await runner.query(`DROP TABLE IF EXISTS public.email_verification_requests`);
  await runner.query(`DROP TABLE IF EXISTS public.profile_sync_intents`);
  await runner.query(`DROP TABLE IF EXISTS public.identity_profiles`);
  await runner.query(`DROP TABLE IF EXISTS public.users`);
}
