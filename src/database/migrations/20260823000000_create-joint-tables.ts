/**
 * 迁移：联合活动模块核心表（joint 域，5.1 JNT-001~006）
 *
 * 版本：20260823000000
 * 归属模块：joint（ADR-002 §2.1；5.1）
 * 权威来源：src/modules/joint/domain 六个聚合快照；与
 * postgres-joint.repository.ts 逐列对齐（迁移与仓储单源一致）。
 *
 * 约束：
 * - 仅受控开发/测试环境；生产 DDL 门保持关闭（GOV-CODE-WAIVER-001）。
 * - 动态/数组类字段（表单引用、参与快照、评价、结论版本、通道窗口）入 JSONB；
 *   业务骨架列固定；聚合以修订号做乐观守卫由应用层保证。
 */

export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.joint_activities (
      id                  text        PRIMARY KEY,
      title               text        NOT NULL,
      description         text        NULL,
      status              text        NOT NULL,
      confirm_round       bigint      NOT NULL DEFAULT 1,
      confirm_deadline    timestamptz NULL,
      published_at        timestamptz NULL,
      first_invitation_at timestamptz NULL,
      cancel_round        bigint      NOT NULL DEFAULT 0,
      forced_ended_reason text        NULL,
      revision_number     bigint      NOT NULL DEFAULT 1,
      created_by          text        NOT NULL,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_joint_activities_status
        CHECK (status IN ('DRAFT_CONFIRMING','ESTABLISHED','PUBLISHED','INVITING',
                          'END_CONFIRMING','ENDED','CANCELLED','FORCE_ENDED'))
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_joint_activities_status
      ON public.joint_activities (status)
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.joint_participants (
      id                text        PRIMARY KEY,
      activity_id       text        NOT NULL REFERENCES public.joint_activities (id),
      club_id           text        NOT NULL,
      round_id          bigint      NOT NULL,
      status            text        NOT NULL,
      decided_by        text        NULL,
      confirmed_at      timestamptz NULL,
      suspended_at      timestamptz NULL,
      resumed_at        timestamptz NULL,
      suspended_for_ms  bigint      NOT NULL DEFAULT 0,
      revision_number   bigint      NOT NULL DEFAULT 1,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_joint_participants_status
        CHECK (status IN ('PROPOSED','CONFIRMED','STALE_RECONFIRM','PARTICIPATING',
                          'EMERGENCY_SUSPENDED','WITHDRAWN')),
      CONSTRAINT uq_joint_participants_activity_club_round
        UNIQUE (activity_id, club_id, round_id)
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_joint_participants_activity
      ON public.joint_participants (activity_id)
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.joint_applications (
      id                    text        PRIMARY KEY,
      joint_activity_id     text        NOT NULL REFERENCES public.joint_activities (id),
      applicant_id          text        NOT NULL,
      status                text        NOT NULL,
      form_ref              jsonb       NULL,
      participants_snapshot jsonb       NOT NULL DEFAULT '[]'::jsonb,
      consent_snapshot_hash text        NULL,
      shared_note           text        NULL,
      revision_number       bigint      NOT NULL DEFAULT 1,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_joint_applications_status
        CHECK (status IN ('DRAFT','SUBMITTED','ARCHIVED')),
      CONSTRAINT uq_joint_applications_activity_applicant
        UNIQUE (joint_activity_id, applicant_id)
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_joint_applications_activity
      ON public.joint_applications (joint_activity_id)
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.joint_interviews (
      id                   text        PRIMARY KEY,
      joint_activity_id    text        NOT NULL REFERENCES public.joint_activities (id),
      joint_application_id text        NOT NULL REFERENCES public.joint_applications (id),
      status               text        NOT NULL,
      scheduled_at         timestamptz NULL,
      location             text        NULL,
      method               text        NULL,
      evaluations          jsonb       NOT NULL DEFAULT '[]'::jsonb,
      voided_reason        text        NULL,
      revision_number      bigint      NOT NULL DEFAULT 1,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_joint_interviews_status
        CHECK (status IN ('PENDING_CHOICE','SCHEDULED','IN_PROGRESS','COMPLETED','VOIDED')),
      CONSTRAINT uq_joint_interviews_application
        UNIQUE (joint_application_id)
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_joint_interviews_activity
      ON public.joint_interviews (joint_activity_id)
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.joint_conclusions (
      id                   text        PRIMARY KEY,
      joint_activity_id    text        NOT NULL REFERENCES public.joint_activities (id),
      joint_application_id text        NOT NULL REFERENCES public.joint_applications (id),
      club_id              text        NOT NULL,
      status               text        NOT NULL,
      decision             text        NULL,
      note                 text        NULL,
      version              bigint      NOT NULL DEFAULT 1,
      decided_by           text        NULL,
      decided_at           timestamptz NULL,
      invite_status        text        NOT NULL DEFAULT 'NONE',
      invitation_id        text        NULL,
      versions             jsonb       NOT NULL DEFAULT '[]'::jsonb,
      revision_number      bigint      NOT NULL DEFAULT 1,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_joint_conclusions_status
        CHECK (status IN ('EDITABLE','REVIEW_PENDING','INVITE_PENDING',
                          'LOCKED_ACCEPTED','ARCHIVED_LOCKED')),
      CONSTRAINT ck_joint_conclusions_decision
        CHECK (decision IN ('ADMIT','TRANSFER','REJECT')),
      CONSTRAINT ck_joint_conclusions_invite_status
        CHECK (invite_status IN ('NONE','PENDING','ACCEPTED','REJECTED')),
      CONSTRAINT uq_joint_conclusions_application_club
        UNIQUE (joint_application_id, club_id)
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_joint_conclusions_activity
      ON public.joint_conclusions (joint_activity_id)
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.joint_channels (
      id              text        PRIMARY KEY,
      joint_activity_id text      NOT NULL REFERENCES public.joint_activities (id),
      status          text        NOT NULL,
      current_window  jsonb       NULL,
      windows         jsonb       NOT NULL DEFAULT '[]'::jsonb,
      revision_number bigint      NOT NULL DEFAULT 1,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_joint_channels_status
        CHECK (status IN ('NOT_OPEN','OPEN','SUSPENDED','CLOSED_FINAL')),
      CONSTRAINT uq_joint_channels_activity
        UNIQUE (joint_activity_id)
    )
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP TABLE IF EXISTS public.joint_channels`);
  await runner.query(`DROP TABLE IF EXISTS public.joint_conclusions`);
  await runner.query(`DROP TABLE IF EXISTS public.joint_interviews`);
  await runner.query(`DROP TABLE IF EXISTS public.joint_applications`);
  await runner.query(`DROP TABLE IF EXISTS public.joint_participants`);
  await runner.query(`DROP TABLE IF EXISTS public.joint_activities`);
}
