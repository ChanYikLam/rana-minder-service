/**
 * 持久任务领取/结算存储（job 模块；ADR-004 租约执行单元）。
 *
 * 对齐 job_tasks 真实表结构（迁移 20260820130000；联调 2026-08-27 重写——
 * 原实现按旧想象结构 id/type/pending/next_run_at 编写，真实 PG 下全线失败）：
 *   task_id text PK（幂等去重键）
 *   task_type text（CASDOOR_SYNC / NOTIFICATION_DELIVERY / FILE_CHECK / ... 大写枚举）
 *   intent_id text UNIQUE（来源意图引用）
 *   idempotency_key text
 *   scope / source jsonb（RLS 上下文与来源描述）
 *   payload jsonb（业务载荷，handler 校验消费）
 *   status text（PENDING / LEASED / RETRYABLE_FAILED / UNCERTAIN /
 *               MANUAL_INTERVENTION / COMPLETED）
 *   attempts int、max_attempts int
 *   not_before timestamptz（PENDING 可执行时刻）
 *   lease_worker_id / lease_version / lease_until / leased_at（租约四列，
 *   CHECK 约束要求同空或同非空）
 *   created_at / updated_at
 *
 * 接口语义（ADR-004 §2，与原实现一致）：
 * - 领取 = 单条 UPDATE ... RETURNING（原子单胜者；过期租约可被再次领取）；
 * - 结算（complete/retry/fail）只允许 LEASED（持租约者）；
 * - retry → RETRYABLE_FAILED（not_before=退避时刻，可再次流转）；
 *   fail → MANUAL_INTERVENTION（人工介入，不自动重试）；
 *   requeue → 回 PENDING（人工重投入口）。
 * 注：真实表无 error 列，失败证据仅保留在业务日志（证据持久化为已知缺口）。
 */

import type { DbAdapter, RlsScope, TransactionContext } from '../../shared/db-adapter';

export type JobTaskStatus = 'pending' | 'running' | 'done' | 'failed';

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
  /** 按状态聚合当前积压/完成情况（只读，供运维状态查询） */
  countByStatus(): Promise<Readonly<Record<JobTaskStatus, number>>>;
  /** 人工重投：将 failed/pending 任务重置为 PENDING 并立即可被领取（手动重试入口） */
  requeue(id: string, nextRunAt: Date, now: Date): Promise<void>;
}

interface JobTaskRow {
  task_id: string;
  task_type: string;
  payload: Record<string, unknown> | string;
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

/** 状态聚合口径：RETRYABLE_FAILED/UNCERTAIN/MANUAL_INTERVENTION 归入 failed 展示 */
const FAILED_GROUP: readonly string[] = ['RETRYABLE_FAILED', 'UNCERTAIN', 'MANUAL_INTERVENTION'];

export class PostgresJobTaskStore implements JobTaskStore {
  constructor(private readonly db: DbAdapter) {}

  async claim(batchSize: number, now: Date, leaseMs: number): Promise<readonly ClaimedJobTask[]> {
    const session = new JobDbSession(this.db);
    try {
      const rows = await session.query<JobTaskRow>(
        `UPDATE job_tasks t
            SET status = 'LEASED',
                lease_worker_id = $4,
                lease_version = (floor(random() * 9000000000) + 1000000000)::bigint,
                lease_until = $2,
                leased_at = NOW(),
                attempts = t.attempts + 1,
                updated_at = NOW()
           FROM (
                  SELECT task_id
                    FROM job_tasks
                   WHERE (status = 'PENDING' AND not_before <= NOW())
                      OR (status = 'LEASED' AND lease_until < $3)
                   ORDER BY created_at, task_id
                   LIMIT $1
                 ) c
          WHERE t.task_id = c.task_id AND t.status IN ('PENDING', 'LEASED')
          RETURNING t.task_id, t.task_type, t.payload, t.attempts`,
        [
          batchSize,
          new Date(now.getTime() + leaseMs),
          now,
          `worker-${process.pid}-${now.getTime()}`,
        ],
      );
      // 先在事务内完成 payload 解析：若某行 payload 损坏导致 JSON.parse 抛错，
      // 会在 catch 中对本次领取整体回滚（任务保持 PENDING，可被再次领取），
      // 避免"已提交但 payload 不可用"的悬空 LEASED 任务。
      const claimed = rows.map((row) => {
        const payload =
          typeof row.payload === 'string'
            ? (JSON.parse(row.payload) as Record<string, unknown>)
            : (row.payload ?? {});
        return {
          id: row.task_id,
          type: row.task_type,
          subjectId:
            typeof payload['subjectId'] === 'string' ? (payload['subjectId'] as string) : '',
          payload,
          attempts: Number(row.attempts),
        };
      });
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
          SET status = 'COMPLETED',
              lease_worker_id = NULL, lease_version = NULL, lease_until = NULL, leased_at = NULL,
              updated_at = $2
        WHERE task_id = $1 AND status = 'LEASED'`,
      [id, now],
    );
  }

  async retry(id: string, nextRunAt: Date, now: Date): Promise<void> {
    await this.mutate(
      `UPDATE job_tasks
          SET status = 'RETRYABLE_FAILED',
              not_before = $2,
              lease_worker_id = NULL, lease_version = NULL, lease_until = NULL, leased_at = NULL,
              updated_at = $3
        WHERE task_id = $1 AND status = 'LEASED'`,
      [id, nextRunAt, now],
    );
  }

  async fail(id: string, error: string, now: Date): Promise<void> {
    // 真实表无 error 列：不可重试失败落 MANUAL_INTERVENTION（错误证据见业务日志）
    void error;
    await this.mutate(
      `UPDATE job_tasks
          SET status = 'MANUAL_INTERVENTION',
              lease_worker_id = NULL, lease_version = NULL, lease_until = NULL, leased_at = NULL,
              updated_at = $2
        WHERE task_id = $1 AND status = 'LEASED'`,
      [id, now],
    );
  }

  async countByStatus(): Promise<Readonly<Record<JobTaskStatus, number>>> {
    const session = new JobDbSession(this.db);
    try {
      const rows = await session.query<{ status: string; cnt: number }>(
        `SELECT status, COUNT(*)::int AS cnt FROM job_tasks GROUP BY status`,
        [],
      );
      const counts: Record<JobTaskStatus, number> = {
        pending: 0,
        running: 0,
        done: 0,
        failed: 0,
      };
      for (const row of rows) {
        if (row.status === 'PENDING') counts.pending += row.cnt;
        else if (row.status === 'LEASED') counts.running += row.cnt;
        else if (row.status === 'COMPLETED') counts.done += row.cnt;
        else if (FAILED_GROUP.includes(row.status)) counts.failed += row.cnt;
      }
      await session.close(true);
      return counts;
    } catch (error) {
      await session.close(false);
      throw error;
    }
  }

  async requeue(id: string, nextRunAt: Date, now: Date): Promise<void> {
    await this.mutate(
      `UPDATE job_tasks
          SET status = 'PENDING',
              not_before = $2,
              lease_worker_id = NULL, lease_version = NULL, lease_until = NULL, leased_at = NULL,
              updated_at = $3
        WHERE task_id = $1 AND status IN ('PENDING', 'RETRYABLE_FAILED', 'MANUAL_INTERVENTION')`,
      [id, nextRunAt, now],
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
