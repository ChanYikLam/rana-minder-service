/**
 * 持久任务领取/结算存储（job 模块；ADR-004 租约执行单元）。
 *
 * job_tasks 表（与业务意图同库同事务登记，见 identity/infrastructure
 * profile-sync-task.writer.ts）：
 *   id text PK（幂等去重键：<type>:<subject>:<field>:<version>）
 *   type text（profile_sync / profile_readback）
 *   subject_id text
 *   payload jsonb
 *   status text（pending / running / done / failed）
 *   attempts int（每次领取 +1）
 *   next_run_at timestamptz null（pending 可执行时刻）
 *   leased_until timestamptz null（running 租约截止）
 *   last_attempt_at / claimed_at / completed_at / failed_at timestamptz null
 *   error text null
 *   created_at timestamptz
 *
 * 语义（ADR-004 §2）：
 * - 领取 = 单条 UPDATE ... RETURNING（原子单胜者：同批候选只有一个执行单元
 *   领取成功；过期租约可被再次领取，至少一次执行，业务以幂等键收口）；
 * - 结算（complete/retry/fail）只允许 running 状态（持租约者）；
 * - 未知任务类型 → 立即失败（不可重试）；执行抛错 → 指数退避重试，
 *   达到最大尝试次数 → 失败（保留错误证据）。
 */

import type { DbAdapter, RlsScope, TransactionContext } from '../../shared/db-adapter';

export interface ClaimedJobTask {
  readonly id: string;
  readonly type: string;
  readonly subjectId: string;
  readonly payload: Record<string, unknown>;
  /** 本次领取后已递增的尝试次数（1 起） */
  readonly attempts: number;
}

export interface JobTaskStore {
  claim(batchSize: number, now: Date, leaseMs: number): Promise<readonly ClaimedJobTask[]>;
  complete(id: string, now: Date): Promise<void>;
  retry(id: string, nextRunAt: Date, now: Date): Promise<void>;
  fail(id: string, error: string, now: Date): Promise<void>;
}

interface JobTaskRow {
  id: string;
  type: string;
  subject_id: string;
  payload: string;
  attempts: number;
}

/** 每笔任务操作的最小事务会话（RLS 平台级 unprotected；归还池前证明无残留） */
class JobDbSession {
  private tx: TransactionContext | null = null;

  constructor(private readonly db: DbAdapter) {}

  private async txOrThrow(): Promise<TransactionContext> {
    if (this.tx === null) {
      this.tx = await this.db.beginTransaction();
      await this.db.setRlsContext(this.tx, { kind: 'unprotected' } satisfies RlsScope);
    }
    return this.tx;
  }

  async query<T>(sql: string, params: readonly unknown[]): Promise<T[]> {
    return this.db.query<T>(await this.txOrThrow(), sql, params);
  }

  async close(success: boolean): Promise<void> {
    if (this.tx === null) {
      return;
    }
    const tx = this.tx;
    this.tx = null;
    if (success) {
      await this.db.commit(tx);
    } else {
      await this.db.rollback(tx);
    }
    await this.db.clearRlsContext(tx);
  }
}

export class PostgresJobTaskStore implements JobTaskStore {
  constructor(private readonly db: DbAdapter) {}

  async claim(batchSize: number, now: Date, leaseMs: number): Promise<readonly ClaimedJobTask[]> {
    const session = new JobDbSession(this.db);
    try {
      const rows = await session.query<JobTaskRow>(
        `UPDATE job_tasks t
            SET status = 'running',
                leased_until = $2,
                claimed_at = NOW(),
                attempts = t.attempts + 1,
                last_attempt_at = NOW()
           FROM (
                  SELECT id
                    FROM job_tasks
                   WHERE (status = 'pending' AND (next_run_at IS NULL OR next_run_at <= NOW()))
                      OR (status = 'running' AND leased_until < $3)
                   ORDER BY created_at, id
                   LIMIT $1
                ) c
          WHERE t.id = c.id AND t.status IN ('pending', 'running')
          RETURNING t.id, t.type, t.subject_id, t.payload, t.attempts`,
        [batchSize, new Date(now.getTime() + leaseMs), now],
      );
      // 先在事务内完成 payload 解析：若某行 payload 损坏导致 JSON.parse 抛错，
      // 会在 catch 中对本次领取整体回滚（任务保持 pending，可被再次领取），
      // 避免"已提交但 payload 不可用"的悬空 running 任务。
      const claimed = rows.map((row) => ({
        id: row.id,
        type: row.type,
        subjectId: row.subject_id,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
        attempts: row.attempts,
      }));
      await session.close(true);
      return claimed;
    } catch (error) {
      await session.close(false);
      throw error;
    }
  }

  async complete(id: string, now: Date): Promise<void> {
    await this.mutate(
      `UPDATE job_tasks
          SET status = 'done', completed_at = $2, leased_until = NULL
        WHERE id = $1 AND status = 'running'`,
      [id, now],
    );
  }

  async retry(id: string, nextRunAt: Date, now: Date): Promise<void> {
    await this.mutate(
      `UPDATE job_tasks
          SET status = 'pending', next_run_at = $2, leased_until = NULL, last_attempt_at = $3
        WHERE id = $1 AND status = 'running'`,
      [id, nextRunAt, now],
    );
  }

  async fail(id: string, error: string, now: Date): Promise<void> {
    await this.mutate(
      `UPDATE job_tasks
          SET status = 'failed', error = $2, failed_at = $3, leased_until = NULL
        WHERE id = $1 AND status = 'running'`,
      [id, error, now],
    );
  }

  private async mutate(sql: string, params: readonly unknown[]): Promise<void> {
    const session = new JobDbSession(this.db);
    try {
      await session.query<JobTaskRow>(sql, params);
      await session.close(true);
    } catch (error) {
      await session.close(false);
      throw error;
    }
  }
}

/**
 * 退避（DEP-001 复核前为候选基线）：基础 5 秒 × 2^(attempts-1)，封顶 1 小时。
 */
export function computeBackoffMs(attempts: number): number {
  const baseMs = 5_000;
  const capMs = 3_600_000;
  const factor = 2 ** Math.max(0, attempts - 1);
  return Math.min(baseMs * factor, capMs);
}
