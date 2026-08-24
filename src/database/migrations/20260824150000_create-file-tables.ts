/**
 * 迁移：文件模块生产基础设施表（4.2 收口；ADR-008 元数据权威在 PostgreSQL）。
 *
 * 版本：20260824150000
 * 归属模块：file
 * 说明：
 * - file_records：文件逻辑记录（元数据/不可变版本/检查状态/定位信息权威在库；
 *   对象存储只对字节负责——ADR-008 §2.2）；嵌套结构（scope/target/versions/
 *   upload_session/check_record/cleanup_queue/deletion_manifest）用 jsonb。
 * - file_access_audit：下载及敏感附件预览访问审计持久化（GOV-008/AUD-004，
 *   不含正文；principal_id 完整标识合规存证）。
 * - file_delete_confirmations：正式删除独立二次确认凭据存证
 *   （AUD-008 一次性签发→核验→作废；防任意字符串绕过）。
 * - 三表均启用 RLS 并放行应用层事务上下文（DbAdapter RlsScope 承担最小上下文，
 *   与 audit 模块迁移模式一致）。
 */

/** 与具体迁移工具解耦的最小查询执行器（工具选型见 DEP-Q-001，未冻结） */
export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  // ---- file_records：文件逻辑记录（嵌套结构 jsonb） ----
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.file_records (
      file_id          text        PRIMARY KEY,
      uploader_id      text        NOT NULL,
      scope            jsonb       NOT NULL,
      category         text        NOT NULL,
      state            text        NOT NULL,
      target           jsonb       NULL,
      version_no       bigint      NOT NULL DEFAULT 1,
      versions         jsonb       NOT NULL DEFAULT '[]',
      upload_session   jsonb       NULL,
      check_record     jsonb       NULL,
      cleanup_queue    jsonb       NOT NULL DEFAULT '[]',
      deletion_manifest jsonb      NULL,
      created_at       timestamptz NOT NULL,
      updated_at       timestamptz NOT NULL,
      CONSTRAINT ck_file_records_state CHECK (state IN
        ('NEW','TEMPORARY_UPLOAD','CHECKING','AVAILABLE','BOUND_TO_SUBMISSION',
         'PENDING_CLEANUP','CLEANED','DELETED'))
    )
  `);
  // 按目标对象/字段列出与计数（listByTarget/createWithinTargetLimit）——
  // 表达式索引：附件上限计数与绑定/清理竞争查询共用
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_file_records_target
      ON public.file_records ((target->>'objectType'), (target->>'objectId'), (target->>'fieldKey'))
      WHERE target IS NOT NULL
  `);
  await runner.query(`ALTER TABLE public.file_records ENABLE ROW LEVEL SECURITY`);
  await runner.query(`DROP POLICY IF EXISTS p_file_records_all ON public.file_records`);
  await runner.query(`
    CREATE POLICY p_file_records_all ON public.file_records
      FOR ALL TO PUBLIC USING (true) WITH CHECK (true)
  `);

  // ---- file_access_audit：访问审计持久化 ----
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.file_access_audit (
      id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      action       text        NOT NULL,
      principal_id text        NOT NULL,
      file_id      text        NOT NULL,
      sensitive    boolean     NOT NULL,
      token        text        NOT NULL,
      occurred_at  timestamptz NOT NULL
    )
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_file_access_audit_file
      ON public.file_access_audit (file_id, occurred_at DESC)
  `);
  await runner.query(`ALTER TABLE public.file_access_audit ENABLE ROW LEVEL SECURITY`);
  await runner.query(`DROP POLICY IF EXISTS p_file_access_audit_all ON public.file_access_audit`);
  await runner.query(`
    CREATE POLICY p_file_access_audit_all ON public.file_access_audit
      FOR ALL TO PUBLIC USING (true) WITH CHECK (true)
  `);

  // ---- file_delete_confirmations：正式删除二次确认凭据存证 ----
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.file_delete_confirmations (
      code         text        PRIMARY KEY,
      expires_at   timestamptz NOT NULL,
      consumed_at  timestamptz NULL,
      created_at   timestamptz NOT NULL
    )
  `);
  await runner.query(`ALTER TABLE public.file_delete_confirmations ENABLE ROW LEVEL SECURITY`);
  await runner.query(
    `DROP POLICY IF EXISTS p_file_delete_confirmations_all ON public.file_delete_confirmations`,
  );
  await runner.query(`
    CREATE POLICY p_file_delete_confirmations_all ON public.file_delete_confirmations
      FOR ALL TO PUBLIC USING (true) WITH CHECK (true)
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP TABLE IF EXISTS public.file_delete_confirmations`);
  await runner.query(`DROP TABLE IF EXISTS public.file_access_audit`);
  await runner.query(`DROP TABLE IF EXISTS public.file_records`);
}
