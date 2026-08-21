/**
 * 迁移：普通招新核心表（recruitment 域，4.4 REC-001~005）
 *
 * 版本：20260822000000
 * 归属模块：recruitment（ADR-002 §2.1；4.4）
 * 权威来源：src/modules/recruitment/domain 五个聚合快照；与
 * postgres-recruitment.repository.ts 逐列对齐（迁移与仓储单源一致）。
 *
 * 约束：
 * - 仅受控开发/测试环境；生产 DDL 门保持关闭（GOV-CODE-WAIVER-001）。
 * - 动态/数组类字段（志愿、表单引用、资格快照、决定版本、评价）入 JSONB；
 *   业务骨架列固定；聚合以修订号/版本做乐观守卫由应用层保证。
 */

export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.recruitment_activities (
      id          text        PRIMARY KEY,
      club_id     text        NOT NULL,
      title       text        NOT NULL,
      description text        NULL,
      status      text        NOT NULL,
      paused      boolean     NOT NULL DEFAULT false,
      end_date    timestamptz NULL,
      created_by  text        NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_recruitment_activities_status
        CHECK (status IN ('DRAFT','OPEN','COMPLETED','CANCELLED'))
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_recruitment_activities_club
      ON public.recruitment_activities (club_id)
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.application_channels (
      id         text        PRIMARY KEY,
      activity_id text       NOT NULL REFERENCES public.recruitment_activities (id),
      club_id    text        NOT NULL,
      status     text        NOT NULL,
      open_at    timestamptz NULL,
      close_at   timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_application_channels_status
        CHECK (status IN ('CLOSED','OPEN','PAUSED'))
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_application_channels_activity
      ON public.application_channels (activity_id)
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.applications (
      id               text        PRIMARY KEY,
      activity_id      text        NOT NULL REFERENCES public.recruitment_activities (id),
      channel_id       text        NOT NULL REFERENCES public.application_channels (id),
      club_id          text        NOT NULL,
      applicant_id     text        NOT NULL,
      status           text        NOT NULL,
      department_choices jsonb      NOT NULL DEFAULT '[]'::jsonb,
      form_ref         jsonb       NULL,
      qualify_snapshot jsonb       NULL,
      revision_number  bigint      NOT NULL DEFAULT 1,
      revisions        jsonb       NOT NULL DEFAULT '[]'::jsonb,
      supplement_due_at timestamptz NULL,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_applications_status
        CHECK (status IN ('DRAFT','SUBMITTED','WITHDRAWN','EXITED',
                          'IDENTITY_EXCEPTION','FINAL_REJECTED')),
      CONSTRAINT uq_applications_applicant_channel
        UNIQUE (applicant_id, channel_id)
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_applications_activity
      ON public.applications (activity_id)
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.department_paths (
      id          text        PRIMARY KEY,
      application_id text     NOT NULL REFERENCES public.applications (id),
      activity_id text        NOT NULL,
      club_id     text        NOT NULL,
      department_id text      NOT NULL,
      status      text        NOT NULL,
      allow_transfer boolean  NOT NULL DEFAULT false,
      decisions   jsonb       NOT NULL DEFAULT '[]'::jsonb,
      previous_status_before_suspend text NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_department_paths_status
        CHECK (status IN ('PENDING','UNDER_REVIEW','ADMITTED','REJECTED',
                          'WAITLISTED','ENDED','SUSPENDED'))
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_department_paths_application
      ON public.department_paths (application_id)
  `);

  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.interview_records (
      id           text        PRIMARY KEY,
      application_id text      NOT NULL REFERENCES public.applications (id),
      activity_id  text        NOT NULL,
      club_id      text        NOT NULL,
      round_id     text        NOT NULL,
      applicant_id text        NOT NULL,
      status       text        NOT NULL,
      interviewer_id text      NULL,
      scheduled_at timestamptz NULL,
      location     text        NULL,
      skip_reason  text        NULL,
      hold_until   timestamptz NULL,
      evaluations  jsonb       NOT NULL DEFAULT '[]'::jsonb,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_interview_records_status
        CHECK (status IN ('PENDING_SELECTION','SELECTED','SCHEDULED','IN_PROGRESS',
                          'COMPLETED','VOIDED','CANCELLED','SKIPPED','ON_HOLD')),
      CONSTRAINT uq_interview_records_application_round
        UNIQUE (application_id, round_id)
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_interview_records_round
      ON public.interview_records (round_id)
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP TABLE IF EXISTS public.interview_records`);
  await runner.query(`DROP TABLE IF EXISTS public.department_paths`);
  await runner.query(`DROP TABLE IF EXISTS public.applications`);
  await runner.query(`DROP TABLE IF EXISTS public.application_channels`);
  await runner.query(`DROP TABLE IF EXISTS public.recruitment_activities`);
}
