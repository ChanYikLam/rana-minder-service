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
 * - 表名/列名 snake_case；主体主键 uuidv7()；JSONB 字段统一命名。
 * - 业务表置于统一 Schema（ADR-014，Schema 名属实现命名，此处显式限定为 public）。
 * - 外部账号状态以 Casdoor 为权威（IFC-DATA-008）；本地只保存稳定映射、可信观测、
 *   同步意图、冲突快照与不可变历史。
 */

/** 与具体迁移工具解耦的最小查询执行器（工具选型见 DEP-Q-001，未冻结） */
export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.users (
      subject_id                    uuid        PRIMARY KEY DEFAULT uuidv7(),
      student_id                    text        NOT NULL,
      casdoor_org                   text        NOT NULL,
      casdoor_name                  text        NOT NULL,
      display_name                  text        NOT NULL,
      account_state                 text        NOT NULL DEFAULT 'ACTIVE',
      degraded_since                timestamptz NULL,
      last_trusted_observation_at   timestamptz NULL,
      session_revoke_version        bigint      NOT NULL DEFAULT 0,
      state_version                 bigint      NOT NULL DEFAULT 0,
      created_at                    timestamptz NOT NULL DEFAULT now(),
      updated_at                    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_users_student_id UNIQUE (student_id),
      CONSTRAINT uq_users_casdoor_binding UNIQUE (casdoor_org, casdoor_name),
      CONSTRAINT ck_users_account_state CHECK (account_state IN
        ('ACTIVE', 'DISABLED', 'DELETED', 'UNVERIFIABLE'))
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_users_account_state ON public.users (account_state)
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.profiles (
      subject_id          uuid        PRIMARY KEY REFERENCES public.users (subject_id),
      email               text        NULL,
      phone               text        NULL,
      college             text        NULL,
      grade               text        NULL,
      email_verified      boolean     NOT NULL DEFAULT false,
      verified_email      text        NULL,
      pending_email       text        NULL,
      version             bigint      NOT NULL DEFAULT 0,
      gate_state          text        NOT NULL DEFAULT 'PENDING_COMPLETION',
      restrictions        jsonb       NOT NULL DEFAULT '{}'::jsonb,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_profiles_gate_state CHECK (gate_state IN
        ('PENDING_COMPLETION', 'PENDING_EMAIL_VERIFICATION', 'WRITABLE', 'PARTIALLY_RESTRICTED'))
    )
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.profile_sync_events (
      id              bigserial   PRIMARY KEY,
      subject_id      uuid        NOT NULL REFERENCES public.users (subject_id),
      field           text        NOT NULL,
      target_version  bigint      NOT NULL,
      prior_value     text        NULL,
      target_value    text        NOT NULL,
      readback_value  text        NULL,
      sync_state      text        NOT NULL DEFAULT 'PENDING_SYNC',
      conflict_version bigint     NULL,
      attempts        integer     NOT NULL DEFAULT 0,
      retry_at        timestamptz NULL,
      failed_since    timestamptz NULL,
      resolved_at     timestamptz NULL,
      error_summary   text        NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_profile_sync_identity UNIQUE (subject_id, field, target_version),
      CONSTRAINT ck_profile_sync_state CHECK (sync_state IN
        ('SYNCED', 'PENDING_SYNC', 'RETRYING', 'PENDING_READBACK_VERIFICATION',
         'ROLLED_BACK', 'CONFLICT_PENDING_USER_CHOICE', 'MANUAL_INTERVENTION'))
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_profile_sync_pending ON public.profile_sync_events
      (subject_id, field, sync_state, retry_at)
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.email_verifications (
      id               uuid        PRIMARY KEY DEFAULT uuidv7(),
      subject_id       uuid        NOT NULL REFERENCES public.users (subject_id),
      email            text        NOT NULL,
      token_hash       text        NOT NULL,
      expires_at       timestamptz NOT NULL,
      consumed_at      timestamptz NULL,
      request_version  bigint      NOT NULL,
      created_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_email_verification_version_positive CHECK (request_version > 0)
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_email_verifications_subject ON public.email_verifications
      (subject_id, request_version)
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.account_access_events (
      id                  bigserial   PRIMARY KEY,
      subject_id          uuid        NOT NULL REFERENCES public.users (subject_id),
      from_state          text        NOT NULL,
      to_state            text        NOT NULL,
      source              text        NOT NULL,
      event_ref           text        NULL,
      readback_evidence   jsonb       NULL,
      occurred_at         timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_account_access_source CHECK (source IN
        ('CASDOOR_EVENT', 'RECONCILIATION', 'READBACK', 'SYSTEM'))
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_account_access_subject ON public.account_access_events (subject_id, occurred_at)
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP TABLE IF EXISTS public.account_access_events`);
  await runner.query(`DROP TABLE IF EXISTS public.email_verifications`);
  await runner.query(`DROP TABLE IF EXISTS public.profile_sync_events`);
  await runner.query(`DROP TABLE IF EXISTS public.profiles`);
  await runner.query(`DROP TABLE IF EXISTS public.users`);
}
