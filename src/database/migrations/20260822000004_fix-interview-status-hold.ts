/**
 * 迁移：修复 interview_records 状态 CHECK 约束与领域状态机不一致（recruitment 域，4.4 评审修复）。
 *
 * 版本：20260822000004
 * 背景：20260822000000 的 ck_interview_records_status 允许 'ON_HOLD' 与 'SELECTED'，
 * 而领域 InterviewRecordStatus 实际使用 'HOLD'（REC-041 暂缓）且无 'SELECTED'。
 * 面试暂缓（hold）落库时会触发 CHECK 违例，导致 500。本迁移将约束收敛为与
 * 领域状态机一致（drop + add 约束），与 20260822000001 处理 applications 的方式一致。
 *
 * 约束：仅受控开发/测试环境；生产 DDL 门保持关闭（GOV-CODE-WAIVER-001）。
 */

export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(
    `ALTER TABLE public.interview_records DROP CONSTRAINT IF EXISTS ck_interview_records_status`,
  );
  await runner.query(
    `ALTER TABLE public.interview_records ADD CONSTRAINT ck_interview_records_status
       CHECK (status IN ('PENDING_SELECTION','SCHEDULED','IN_PROGRESS','COMPLETED',
                         'VOIDED','CANCELLED','SKIPPED','HOLD'))`,
  );
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(
    `ALTER TABLE public.interview_records DROP CONSTRAINT IF EXISTS ck_interview_records_status`,
  );
  await runner.query(
    `ALTER TABLE public.interview_records ADD CONSTRAINT ck_interview_records_status
       CHECK (status IN ('PENDING_SELECTION','SELECTED','SCHEDULED','IN_PROGRESS',
                         'COMPLETED','VOIDED','CANCELLED','SKIPPED','ON_HOLD'))`,
  );
}
