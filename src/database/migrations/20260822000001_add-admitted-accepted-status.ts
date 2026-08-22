/**
 * 迁移：补齐 applications 状态 CHECK 约束（recruitment 域，4.4 评审修复）。
 *
 * 版本：20260822000001
 * 背景：20260822000000 的 ck_applications_status 未含 ADMITTED / ACCEPTED，
 * 领域状态机扩展后 admission.use-case 会以这两状态落库，已执行该迁移的环境
 * 将触发 CHECK 违例。本迁移对线上/测试已执行环境追加状态（drop + add 约束）。
 *
 * 约束：仅受控开发/测试环境；生产 DDL 门保持关闭（GOV-CODE-WAIVER-001）。
 */

export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(
    `ALTER TABLE public.applications DROP CONSTRAINT IF EXISTS ck_applications_status`,
  );
  await runner.query(
    `ALTER TABLE public.applications ADD CONSTRAINT ck_applications_status
       CHECK (status IN ('DRAFT','SUBMITTED','WITHDRAWN','EXITED',
                         'IDENTITY_EXCEPTION','FINAL_REJECTED','ADMITTED','ACCEPTED'))`,
  );
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(
    `ALTER TABLE public.applications DROP CONSTRAINT IF EXISTS ck_applications_status`,
  );
  await runner.query(
    `ALTER TABLE public.applications ADD CONSTRAINT ck_applications_status
       CHECK (status IN ('DRAFT','SUBMITTED','WITHDRAWN','EXITED',
                         'IDENTITY_EXCEPTION','FINAL_REJECTED'))`,
  );
}
