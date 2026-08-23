/**
 * 迁移：正式删除与临时清理（audit）表族（IFC-TX-007、AUD-005~010）
 *
 * 版本：20260823120000
 * 归属模块：audit
 * 权威来源：docs/specification/数据模型与约束-v1.0.md（AUD-005~010）、
 * ADR-014（单数据库统一应用业务 Schema）、SRS-SM-AUD-001。
 *
 * 约束：
 * - 仅用于受控开发/测试环境（GOV-CODE-WAIVER-001 边界）；生产 DDL 门保持关闭。
 * - **独立持久化**（IFC-TX-007/AUD-009）：删除执行清单不可内存暂存——重启丢失将
 *   导致恢复备份后重放失效；表结构与本模块 postgres-deletion-checklist-repository
 *   逐列对齐（评审要求迁移与仓储单源一致）。
 * - **乐观锁**：version 列 + 应用层事务内 `SELECT ... FOR UPDATE` 版本比较，
 *   同一清单并发执行只一个提交成功（防重复删除）。
 * - **最小审计语义**：删除后仅保留内部记录标识/时间/执行超管/删除类型与结构化
 *   用途（purpose 白名单随清单落库，供合规追溯）；不保留姓名/报名内容/评价/附件正文。
 * - 启用行级安全（RLS）并放行应用层事务上下文（DbAdapter RlsScope 承担最小上下文）；
 *   表级不额外拦截，与 audit_event 迁移模式一致。
 */

/** 与具体迁移工具解耦的最小查询执行器（工具选型见 DEP-Q-001，未冻结） */
export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`
    CREATE TABLE IF NOT EXISTS public.deletion_checklist (
      checklist_id            text        PRIMARY KEY,
      scope                   jsonb       NOT NULL,
      reason                  text        NOT NULL,
      purpose                 text        NOT NULL,
      initiated_by            text        NOT NULL,
      initiated_at            timestamptz NOT NULL,
      confirmed               boolean     NOT NULL DEFAULT false,
      affected_objects        jsonb       NOT NULL DEFAULT '[]'::jsonb,
      business_relations_ended boolean    NOT NULL DEFAULT false,
      steps                   jsonb       NOT NULL DEFAULT '[]'::jsonb,
      completed               boolean     NOT NULL DEFAULT false,
      replay_count            bigint      NOT NULL DEFAULT 0,
      retry_count             bigint      NOT NULL DEFAULT 0,
      needs_manual_review     boolean     NOT NULL DEFAULT false,
      version                 bigint      NOT NULL DEFAULT 1,
      audit_committed         boolean     NOT NULL DEFAULT false,
      CONSTRAINT ck_deletion_checklist_purpose CHECK (purpose IN
        ('USER_REQUEST', 'LEGAL_REQUIREMENT', 'DATA_QUALITY', 'RETENTION_VIOLATION'))
    )
  `);

  // 恢复重放/普通重试查询索引（AUD-009）：未完成清单、全量清单按发起时间排序
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_deletion_checklist_completed
      ON public.deletion_checklist (completed, initiated_at DESC)
  `);
  await runner.query(`
    CREATE INDEX IF NOT EXISTS idx_deletion_checklist_scope
      ON public.deletion_checklist (((scope->>'kind')), initiated_at DESC)
  `);

  // 行级安全：启用 RLS；应用层事务上下文（DbAdapter RlsScope）承担最小上下文，
  // 表级放行（与 audit_event 迁移一致，删除属超管平台级操作）
  await runner.query(`ALTER TABLE public.deletion_checklist ENABLE ROW LEVEL SECURITY`);
  await runner.query(`
    CREATE POLICY p_deletion_checklist_all ON public.deletion_checklist
      FOR ALL TO PUBLIC USING (true) WITH CHECK (true)
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP POLICY IF EXISTS public.p_deletion_checklist_all`);
  await runner.query(`ALTER TABLE public.deletion_checklist DISABLE ROW LEVEL SECURITY`);
  await runner.query(`DROP INDEX IF EXISTS public.idx_deletion_checklist_scope`);
  await runner.query(`DROP INDEX IF EXISTS public.idx_deletion_checklist_completed`);
  await runner.query(`DROP TABLE IF EXISTS public.deletion_checklist`);
}
