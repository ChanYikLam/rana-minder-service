/**
 * 迁移：application_channels 增加 min_choices / max_choices（recruitment 域，4.4 评审修复）。
 *
 * 版本：20260822000003
 * 背景：评审指出志愿数量约束 minChoices/maxChoices 由客户端透传可被绕过。改为服务端
 * 由报名通道配置决定，提交时从通道快照取用，不信任客户端输入。
 *
 * 约束：仅受控开发/测试环境；生产 DDL 门保持关闭（GOV-CODE-WAIVER-001）。
 */

export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(
    `ALTER TABLE public.application_channels ADD COLUMN IF NOT EXISTS min_choices integer NOT NULL DEFAULT 1`,
  );
  await runner.query(
    `ALTER TABLE public.application_channels ADD COLUMN IF NOT EXISTS max_choices integer NOT NULL DEFAULT 1`,
  );
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`ALTER TABLE public.application_channels DROP COLUMN IF EXISTS min_choices`);
  await runner.query(`ALTER TABLE public.application_channels DROP COLUMN IF EXISTS max_choices`);
}
