/**
 * 迁移：interview_records 状态 CHECK 扩展 + 同面试官同时段排期唯一索引。
 *
 * 版本：20260828120000
 * 归属模块：recruitment
 * 说明：
 * 1. 状态机（interview-record.state-machine）已支持 LEAVE / LATE / ABSENT 三种
 *    出勤状态（SM-REC-005 状态转移），但 dev 分支迁移 `ck_interview_records_status`
 *    仅覆盖 SCHEDULED/IN_PROGRESS 等 6 态，状态机允许但 PG CHECK 拒绝写入
 *    （Top-4/HIGH）。
 * 2. UNIQUE (application_id, round_id) 已防"同一申请同一轮次"重复排期，但未防
 *    "同一面试官同一时刻双排"——choose-interview-slot 缺并发约束
 *    （Top-5/HIGH）。加 partial unique index 限定非作废/非取消的排期行。
 *
 * 修复映射（review/db-code-audit 报告 Top-4/Top-5）：
 * - 替换 CHECK 约束加入 LEAVE / LATE / ABSENT
 * - 新建 partial unique index（round_id, interviewer_id, scheduled_at）WHERE 状态非作废/非取消
 */

export interface MigrationQueryRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export async function up(runner: MigrationQueryRunner): Promise<void> {
  // 1) 扩展状态 CHECK
  await runner.query(`
    ALTER TABLE public.interview_records
      DROP CONSTRAINT IF EXISTS ck_interview_records_status
  `);
  await runner.query(`
    ALTER TABLE public.interview_records
      ADD CONSTRAINT ck_interview_records_status
      CHECK (status IN ('PENDING_SELECTION','SELECTED','SCHEDULED','IN_PROGRESS',
                        'COMPLETED','VOIDED','CANCELLED','SKIPPED','ON_HOLD',
                        'ON_LEAVE','LATE','ABSENT'))
  `);

  // 2) 同面试官同时段排期唯一索引（partial：仅对已排期行生效）
  await runner.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_interview_round_interviewer_slot
      ON public.interview_records (round_id, interviewer_id, scheduled_at)
      WHERE status NOT IN ('VOIDED','CANCELLED') AND scheduled_at IS NOT NULL
  `);
}

export async function down(runner: MigrationQueryRunner): Promise<void> {
  await runner.query(`DROP INDEX IF EXISTS public.uq_interview_round_interviewer_slot`);
  await runner.query(`
    ALTER TABLE public.interview_records
      DROP CONSTRAINT IF EXISTS ck_interview_records_status
  `);
  await runner.query(`
    ALTER TABLE public.interview_records
      ADD CONSTRAINT ck_interview_records_status
      CHECK (status IN ('PENDING_SELECTION','SELECTED','SCHEDULED','IN_PROGRESS',
                        'COMPLETED','VOIDED','CANCELLED','SKIPPED','ON_HOLD'))
  `);
}
