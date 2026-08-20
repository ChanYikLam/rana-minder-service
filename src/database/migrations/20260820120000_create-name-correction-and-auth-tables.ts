/**
 * 迁移：姓名更正申请与认证支撑表族（IDN-016 姓名更正、IDN-008 会话失效、CAS-REC-003 重认证证据）
 *
 * 版本：20260820120000
 * 归属模块：identity
 * 权威来源：docs/specification/数据模型与约束-v1.0.md（IDN-008/016、CAS-REC-003、
 * ORG-029 超管 Group）、ADR-014（单数据库统一应用业务 Schema）。
 *
 * 约束：
 * - 仅用于受控开发/测试环境（GOV-CODE-WAIVER-001 边界）；生产 DDL 门保持关闭。
 * - 证明只存引用（proof_reference），不存附件正文；重认证证据只存时间戳。
 * - 会话表由认证链路（3.3）写入；本迁移只建结构，不建会话数据。
 */

import type { MigrationQueryRunner } from './20260820100000_create-identity-tables';

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.name_correction_requests (
      id                uuid        PRIMARY KEY DEFAULT uuidv7(),
      subject_id        uuid        NOT NULL REFERENCES public.users (subject_id),
      old_name          text        NOT NULL,
      requested_name    text        NOT NULL,
      proof_reference   text        NULL,
      status            text        NOT NULL DEFAULT 'SUBMITTED',
      decided_by        text        NULL,
      decided_at        timestamptz NULL,
      decision_reason   text        NULL,
      applied_at        timestamptz NULL,
      version           integer     NOT NULL DEFAULT 0,
      created_at        timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_name_correction_status CHECK (status IN
        ('SUBMITTED', 'APPROVED', 'REJECTED')),
      CONSTRAINT ck_name_correction_length CHECK (
        char_length(old_name) BETWEEN 1 AND 64 AND
        char_length(requested_name) BETWEEN 1 AND 64
      )
    )
  `);
  await runner.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_name_correction_pending
      ON public.name_correction_requests (subject_id)
      WHERE status = 'SUBMITTED'
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.auth_reauth_evidence (
      subject_id      uuid        PRIMARY KEY REFERENCES public.users (subject_id),
      reauth_at       timestamptz NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now()
    )
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.auth_sessions (
      session_id      text        PRIMARY KEY,
      subject_id      uuid        NOT NULL REFERENCES public.users (subject_id),
      revoke_version  bigint      NOT NULL DEFAULT 0,
      revoked_at      timestamptz NULL,
      created_at      timestamptz NOT NULL DEFAULT now()
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_subject ON public.auth_sessions (subject_id)
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP TABLE IF EXISTS public.auth_sessions`);
  await runner.query(`DROP TABLE IF EXISTS public.auth_reauth_evidence`);
  await runner.query(`DROP TABLE IF EXISTS public.name_correction_requests`);
}