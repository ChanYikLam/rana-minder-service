/**
 * 迁移：通知模块生产基础设施表（4.3 收口；12 个 InMemory 桩 → PostgreSQL）。
 *
 * 版本：20260825100000
 * 归属模块：notification
 * 说明：
 * - notification_facts：通知事实 + 收件人快照 + 去重键（NTF-003）；查询列列化，
 *   业务负载 jsonb；
 * - notification_inbox_presentations：站内信唯一呈现记录（NTF-003）；
 * - channel_delivery_attempts：渠道投递尝试（重试/外发箱查询）；
 * - email_templates：邮件模板（作用域+类型唯一，版本快照 jsonb，NTF-005）；
 * - notification_configs：统一 KV 配置（紧急关闭/邮件配置/偏好/社团策略/平台停用）；
 * - privileged_audit：特权操作审计（紧急关闭等高危操作留痕）。
 * 六表均启用 RLS 并放行应用层事务上下文（与 audit/file 迁移模式一致）。
 */

/** 与具体迁移工具解耦的最小查询执行器（工具选型见 DEP-Q-001，未冻结） */
export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  // ---- notification_facts ----
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.notification_facts (
      fact_id            text        PRIMARY KEY,
      dedup_key          text        NOT NULL UNIQUE,
      logical_event_id   text        NOT NULL,
      event_type         text        NOT NULL,
      status             text        NOT NULL,
      version            bigint      NOT NULL DEFAULT 1,
      payload            jsonb       NOT NULL DEFAULT '{}',
      recipient_snapshots jsonb      NOT NULL DEFAULT '[]',
      created_at         timestamptz NOT NULL,
      updated_at         timestamptz NOT NULL,
      CONSTRAINT ck_notification_facts_status CHECK (status IN
        ('CREATED_PENDING_DELIVERY','CREATED_PAUSED_DELIVERY','DELIVERED'))
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_notification_facts_status
      ON public.notification_facts (status, created_at)
  `);
  await runner.query(`ALTER TABLE public.notification_facts ENABLE ROW LEVEL SECURITY`);
  await runner.query(`DROP POLICY IF EXISTS p_notification_facts_all ON public.notification_facts`);
  await runner.query(`
    CREATE POLICY p_notification_facts_all ON public.notification_facts
      FOR ALL TO PUBLIC USING (true) WITH CHECK (true)
  `);

  // ---- notification_inbox_presentations ----
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.notification_inbox_presentations (
      presentation_id  text        PRIMARY KEY,
      fact_id          text        NOT NULL,
      recipient_id     text        NOT NULL,
      status           text        NOT NULL,
      deadline_status  text        NULL,
      event_type       text        NOT NULL,
      title            text        NOT NULL,
      body             text        NOT NULL,
      link             text        NULL,
      club_name        text        NULL,
      delivered_at     timestamptz NOT NULL,
      read_at          timestamptz NULL,
      version          bigint      NOT NULL DEFAULT 1,
      payload          jsonb       NOT NULL DEFAULT '{}',
      created_at       timestamptz NOT NULL,
      updated_at       timestamptz NOT NULL,
      CONSTRAINT uq_notification_presentation_fact_recipient UNIQUE (fact_id, recipient_id),
      CONSTRAINT ck_notification_inbox_status CHECK (status IN
        ('READ','UNREAD','PROCESSED','HIDDEN'))
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_notification_inbox_recipient
      ON public.notification_inbox_presentations (recipient_id, status, created_at DESC)
  `);
  await runner.query(
    `ALTER TABLE public.notification_inbox_presentations ENABLE ROW LEVEL SECURITY`,
  );
  await runner.query(
    `DROP POLICY IF EXISTS p_notification_inbox_presentations_all ON public.notification_inbox_presentations`,
  );
  await runner.query(`
    CREATE POLICY p_notification_inbox_presentations_all ON public.notification_inbox_presentations
      FOR ALL TO PUBLIC USING (true) WITH CHECK (true)
  `);

  // ---- channel_delivery_attempts ----
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.channel_delivery_attempts (
      attempt_id          text        PRIMARY KEY,
      fact_id             text        NOT NULL,
      snapshot_id         text        NULL,
      recipient_id        text        NULL,
      channel             text        NOT NULL,
      status              text        NOT NULL,
      attempt_number      bigint      NOT NULL DEFAULT 1,
      channel_message_id  text        NULL,
      target_address      text        NULL,
      template_version_id text        NULL,
      sender_identity     text        NULL,
      email_subject       text        NULL,
      email_body          text        NULL,
      first_failed_at     timestamptz NULL,
      payload             jsonb       NOT NULL DEFAULT '{}',
      created_at          timestamptz NOT NULL,
      updated_at          timestamptz NOT NULL,
      CONSTRAINT ck_channel_delivery_attempts_status CHECK (status IN
        ('PENDING','DELIVERED','FAILED_RETRY','PERMANENT_FAILURE'))
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_channel_delivery_attempts_status
      ON public.channel_delivery_attempts (status, created_at)
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_channel_delivery_attempts_fact
      ON public.channel_delivery_attempts (fact_id)
  `);
  await runner.query(`ALTER TABLE public.channel_delivery_attempts ENABLE ROW LEVEL SECURITY`);
  await runner.query(
    `DROP POLICY IF EXISTS p_channel_delivery_attempts_all ON public.channel_delivery_attempts`,
  );
  await runner.query(`
    CREATE POLICY p_channel_delivery_attempts_all ON public.channel_delivery_attempts
      FOR ALL TO PUBLIC USING (true) WITH CHECK (true)
  `);

  // ---- email_templates ----
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.email_templates (
      template_id    text        PRIMARY KEY,
      scope_type     text        NOT NULL,
      scope_key      text        NOT NULL,
      kind           text        NOT NULL,
      active_version bigint      NOT NULL DEFAULT 1,
      versions       jsonb       NOT NULL DEFAULT '[]',
      created_at     timestamptz NOT NULL,
      updated_at     timestamptz NOT NULL,
      CONSTRAINT uq_email_templates_scope UNIQUE (scope_type, scope_key, kind)
    )
  `);
  await runner.query(`ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY`);
  await runner.query(`DROP POLICY IF EXISTS p_email_templates_all ON public.email_templates`);
  await runner.query(`
    CREATE POLICY p_email_templates_all ON public.email_templates
      FOR ALL TO PUBLIC USING (true) WITH CHECK (true)
  `);

  // ---- notification_configs（统一 KV） ----
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.notification_configs (
      config_kind text        NOT NULL,
      config_key  text        NOT NULL,
      value       jsonb       NOT NULL,
      updated_at  timestamptz NOT NULL,
      PRIMARY KEY (config_kind, config_key)
    )
  `);
  await runner.query(`ALTER TABLE public.notification_configs ENABLE ROW LEVEL SECURITY`);
  await runner.query(
    `DROP POLICY IF EXISTS p_notification_configs_all ON public.notification_configs`,
  );
  await runner.query(`
    CREATE POLICY p_notification_configs_all ON public.notification_configs
      FOR ALL TO PUBLIC USING (true) WITH CHECK (true)
  `);

  // ---- privileged_audit ----
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.notification_privileged_audit (
      id          text        PRIMARY KEY,
      actor_id    text        NOT NULL,
      actor_name  text        NOT NULL,
      action      text        NOT NULL,
      scope       text        NOT NULL,
      target_type text        NOT NULL,
      target_id   text        NOT NULL,
      reason      text        NOT NULL,
      detail      jsonb       NOT NULL DEFAULT '{}',
      trace_id    text        NULL,
      occurred_at timestamptz NOT NULL
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_notification_privileged_audit_actor
      ON public.notification_privileged_audit (actor_id, occurred_at DESC)
  `);
  await runner.query(`ALTER TABLE public.notification_privileged_audit ENABLE ROW LEVEL SECURITY`);
  await runner.query(
    `DROP POLICY IF EXISTS p_notification_privileged_audit_all ON public.notification_privileged_audit`,
  );
  await runner.query(`
    CREATE POLICY p_notification_privileged_audit_all ON public.notification_privileged_audit
      FOR ALL TO PUBLIC USING (true) WITH CHECK (true)
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  // 与 up 侧对称：先删策略、再关 RLS，最后删表（避免遗留 policy/RLS 漂移）。
  await runner.query(
    `DROP POLICY IF EXISTS p_notification_privileged_audit_all ON public.notification_privileged_audit`,
  );
  await runner.query(`ALTER TABLE public.notification_privileged_audit DISABLE ROW LEVEL SECURITY`);
  await runner.query(
    `DROP POLICY IF EXISTS p_notification_configs_all ON public.notification_configs`,
  );
  await runner.query(`ALTER TABLE public.notification_configs DISABLE ROW LEVEL SECURITY`);
  await runner.query(`DROP POLICY IF EXISTS p_email_templates_all ON public.email_templates`);
  await runner.query(`ALTER TABLE public.email_templates DISABLE ROW LEVEL SECURITY`);
  await runner.query(
    `DROP POLICY IF EXISTS p_channel_delivery_attempts_all ON public.channel_delivery_attempts`,
  );
  await runner.query(`ALTER TABLE public.channel_delivery_attempts DISABLE ROW LEVEL SECURITY`);
  await runner.query(
    `DROP POLICY IF EXISTS p_notification_inbox_presentations_all ON public.notification_inbox_presentations`,
  );
  await runner.query(
    `ALTER TABLE public.notification_inbox_presentations DISABLE ROW LEVEL SECURITY`,
  );
  await runner.query(`DROP POLICY IF EXISTS p_notification_facts_all ON public.notification_facts`);
  await runner.query(`ALTER TABLE public.notification_facts DISABLE ROW LEVEL SECURITY`);
  await runner.query(`DROP TABLE IF EXISTS public.notification_privileged_audit`);
  await runner.query(`DROP TABLE IF EXISTS public.notification_configs`);
  await runner.query(`DROP TABLE IF EXISTS public.email_templates`);
  await runner.query(`DROP TABLE IF EXISTS public.channel_delivery_attempts`);
  await runner.query(`DROP TABLE IF EXISTS public.notification_inbox_presentations`);
  await runner.query(`DROP TABLE IF EXISTS public.notification_facts`);
}
