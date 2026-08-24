/**
 * PostgreSQL 后台任务仓储（infrastructure；DATA-JOB-001 持久化）。
 *
 * 表：job_tasks（结构与迁移 20260822120000_create-job-task-tables 逐列对齐）。
 *
 * 权威依据：
 * - ADR-004（权威业务库持久任务 + 独立后台执行单元；至少一次执行）
 * - DATA-JOB-001/002（通用任务执行信封字段；每次执行重检源状态/版本/幂等）
 * - DATA-CON-006（任务领取原子跳过已被有效租约占用的任务；旧令牌提交必须失败）
 * - SEC-VER-011（旧租约、重复领取、租约过期迟到提交不能提交业务结果）
 *
 * 并发守卫（评审要求 SQL 层单胜者）：
 * - tryClaim：单条条件 UPDATE 原子领取——WHERE 含“可领取状态 + 可执行时间 +
 *   (租约为空或已到期)”，并发双 worker 只有一方 WHERE 命中，另一方 0 行即 LEASE_BUSY。
 * - updateAfterExecution：以 lease_version 为 WHERE 守卫（0 行 → 旧租约/终态拒绝，
 *   SEC-VER-011），且终态（COMPLETED）不允许再被改写。
 * - 所有写路径在单条原子语句内完成，不依赖应用层预查再提交（竞争边界交给数据库约束）。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DbAdapter, TransactionContext } from '../../../shared/db-adapter';
import { DB_ADAPTER } from '../../../adapters/tokens';
import { deriveTrackingNumber } from '../contracts/task-intent';
import { TaskStatus } from '../contracts/task-status';
import type { TaskIntent } from '../contracts/task-intent';
import type { TaskFailure, TaskLease, TaskRecord, TaskRecordPatch } from '../contracts/task-record';
import type { TaskBacklogSummary, TaskClaimResult, TaskRepository } from '../contracts/task-ports';
import { TaskType } from '../contracts/task-type';

/** 默认最大尝试数（与 InMemoryTaskRepository 一致；后续由任务类型策略配置化） */
const DEFAULT_MAX_ATTEMPTS = 5;

interface JobTaskRow {
  task_id: string;
  task_type: string;
  status: string;
  intent_id: string;
  idempotency_key: string;
  scope: TaskRecord['scope'];
  source: TaskRecord['source'];
  payload: unknown;
  lease_worker_id: string | null;
  lease_version: string | null;
  lease_until: Date | null;
  leased_at: Date | null;
  attempts: string;
  max_attempts: string;
  not_before: Date;
  failure: TaskFailure | null;
  result_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

const RUNNABLE_STATUSES = `('${TaskStatus.PENDING}','${TaskStatus.RETRYABLE_FAILED}')`;

function rowToRecord(row: JobTaskRow): TaskRecord {
  return {
    taskId: row.task_id,
    taskType: row.task_type as TaskType,
    status: row.status as TaskStatus,
    intentId: row.intent_id,
    idempotencyKey: row.idempotency_key,
    scope: row.scope,
    source: row.source,
    payload: row.payload,
    lease:
      row.lease_worker_id === null
        ? null
        : ({
            workerId: row.lease_worker_id,
            leaseVersion: Number(row.lease_version),
            leaseUntil: row.lease_until!.toISOString(),
            leasedAt: row.leased_at!.toISOString(),
          } satisfies TaskLease),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    notBefore: row.not_before.toISOString(),
    failure: row.failure,
    resultRef: row.result_ref,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

@Injectable()
export class PostgresTaskRepository implements TaskRepository {
  private readonly logger = new Logger(PostgresTaskRepository.name);

  constructor(@Inject(DB_ADAPTER) private readonly db: DbAdapter) {}

  /** 后台任务执行属技术运行域，不适用普通社团 RLS（ADR-005：专用数据库身份与来源作用域） */
  private async withTx<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const tx = await this.db.beginTransaction();
    try {
      await this.db.setRlsContext(tx, { kind: 'unprotected' });
      const result = await fn(tx);
      await this.db.commit(tx);
      return result;
    } catch (error) {
      await this.db.rollback(tx).catch(() => undefined);
      throw error;
    } finally {
      await this.db.clearRlsContext(tx).catch(() => undefined);
    }
  }

  async insert(intent: TaskIntent): Promise<TaskRecord> {
    return this.withTx(async (tx) => {
      const taskId = deriveTrackingNumber(intent.intentId, intent.taskType);
      const createdAt = intent.createdAt;
      // 幂等去重：同一 idempotency_key 已登记时直接返回既有任务，避免触发
      // uq_job_tasks_idempotency_key 唯一约束报错（DATA-CON-003 / 与 intent_id 幂等口径一致）。
      // 在同一事务 tx 内查询，避免嵌套开启新事务/新连接。
      const byKey = await this.db.query<JobTaskRow>(
        tx,
        `SELECT task_id, task_type, status, intent_id, idempotency_key, scope, source,
                payload, lease_worker_id, lease_version, lease_until, leased_at,
                attempts, max_attempts, not_before, failure, result_ref, created_at, updated_at
           FROM public.job_tasks WHERE idempotency_key = $1`,
        [intent.idempotencyKey],
      );
      if (byKey[0] !== undefined) return rowToRecord(byKey[0]);
      await this.db.query(
        tx,
        `INSERT INTO public.job_tasks
              (task_id, task_type, status, intent_id, idempotency_key, scope, source,
               payload, lease_worker_id, lease_version, lease_until, leased_at,
               attempts, max_attempts, not_before, failure, result_ref, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL,NULL,NULL,0,$9,$10,NULL,NULL,$11,$11)
         ON CONFLICT DO NOTHING`,
        [
          taskId,
          intent.taskType,
          TaskStatus.PENDING,
          intent.intentId,
          intent.idempotencyKey,
          JSON.stringify(intent.scope),
          JSON.stringify(intent.source),
          JSON.stringify(intent.payload),
          DEFAULT_MAX_ATTEMPTS,
          intent.notBefore,
          createdAt,
        ],
      );
      const rows = await this.db.query<JobTaskRow>(
        tx,
        `SELECT task_id, task_type, status, intent_id, idempotency_key, scope, source,
                payload, lease_worker_id, lease_version, lease_until, leased_at,
                attempts, max_attempts, not_before, failure, result_ref, created_at, updated_at
           FROM public.job_tasks WHERE intent_id = $1`,
        [intent.intentId],
      );
      if (rows[0] !== undefined) return rowToRecord(rows[0]);
      // 兜底：`ON CONFLICT DO NOTHING` 会一并抑制 idempotency_key 唯一约束冲突
      // （并发写入同一 idempotency_key 的不同 intent），此时按 idempotency_key 读回既有任务。
      const byKeyAfter = await this.db.query<JobTaskRow>(
        tx,
        `SELECT task_id, task_type, status, intent_id, idempotency_key, scope, source,
                payload, lease_worker_id, lease_version, lease_until, leased_at,
                attempts, max_attempts, not_before, failure, result_ref, created_at, updated_at
           FROM public.job_tasks WHERE idempotency_key = $1`,
        [intent.idempotencyKey],
      );
      if (byKeyAfter[0] !== undefined) return rowToRecord(byKeyAfter[0]);
      throw new Error(
        `PostgresTaskRepository.insert: 任务插入后未读到记录 intentId=${intent.intentId}`,
      );
    });
  }

  async findById(taskId: string): Promise<TaskRecord | null> {
    return this.withTx(async (tx) => {
      const rows = await this.db.query<JobTaskRow>(
        tx,
        `SELECT task_id, task_type, status, intent_id, idempotency_key, scope, source,
                payload, lease_worker_id, lease_version, lease_until, leased_at,
                attempts, max_attempts, not_before, failure, result_ref, created_at, updated_at
           FROM public.job_tasks WHERE task_id = $1`,
        [taskId],
      );
      return rows[0] ? rowToRecord(rows[0]) : null;
    });
  }

  async findByIntentId(intentId: string): Promise<TaskRecord | null> {
    return this.withTx(async (tx) => {
      const rows = await this.db.query<JobTaskRow>(
        tx,
        `SELECT task_id, task_type, status, intent_id, idempotency_key, scope, source,
                payload, lease_worker_id, lease_version, lease_until, leased_at,
                attempts, max_attempts, not_before, failure, result_ref, created_at, updated_at
           FROM public.job_tasks WHERE intent_id = $1`,
        [intentId],
      );
      return rows[0] ? rowToRecord(rows[0]) : null;
    });
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<TaskRecord | null> {
    return this.withTx(async (tx) => {
      const rows = await this.db.query<JobTaskRow>(
        tx,
        `SELECT task_id, task_type, status, intent_id, idempotency_key, scope, source,
                payload, lease_worker_id, lease_version, lease_until, leased_at,
                attempts, max_attempts, not_before, failure, result_ref, created_at, updated_at
           FROM public.job_tasks WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      return rows[0] ? rowToRecord(rows[0]) : null;
    });
  }

  async tryClaim(
    taskId: string,
    workerId: string,
    leaseUntil: string,
    leaseVersion: number,
    now: Date,
  ): Promise<TaskClaimResult> {
    return this.withTx(async (tx) => {
      const nowIso = now.toISOString();
      // 单条条件 UPDATE 原子领取：排除终态/人工处置，且租约空/已到期者命中。
      // 并发双 worker 竞争同一任务时，只有先到的一方 WHERE 命中，另一方 0 行（LEASE_BUSY）。
      // 说明：status 为 LEASED 但租约已到期的任务也可被重领（SEC-VER-011 过期重领），
      // 因此不把状态限定为 PENDING/RETRYABLE_FAILED，而是排除 COMPLETED/MANUAL_INTERVENTION。
      const rows = await this.db.query<JobTaskRow>(
        tx,
        `UPDATE public.job_tasks
            SET status = $2,
                lease_worker_id = $3,
                lease_until = $4,
                lease_version = COALESCE(lease_version, 0) + 1,
                leased_at = $5,
                updated_at = $5
          WHERE task_id = $1
            AND status <> $6
            AND status <> $7
            AND not_before <= $5
            AND (lease_until IS NULL OR lease_until <= $5)
          RETURNING task_id, task_type, status, intent_id, idempotency_key, scope, source,
                payload, lease_worker_id, lease_version, lease_until, leased_at,
                attempts, max_attempts, not_before, failure, result_ref, created_at, updated_at`,
        // 注：lease_version 由 SQL 原子计算（COALESCE(lease_version,0)+1），
        // 不信任调用方基于预读的旧版本号，避免版本回退削弱 SEC-VER-011 旧令牌守卫。
        // 状态常量以 $6/$7 参数化传入（BUG-015 修复：避免 SQL 模板插值）。
        [taskId, TaskStatus.LEASED, workerId, leaseUntil, nowIso, TaskStatus.COMPLETED, TaskStatus.MANUAL_INTERVENTION],
      );
      if (rows[0] !== undefined) {
        return { claimed: true, task: rowToRecord(rows[0]) };
      }
      // 0 行：区分原因（仅诊断，不做预查即提交——领取本身已原子）
      const current = await this.db.query<JobTaskRow>(
        tx,
        `SELECT task_id, task_type, status, intent_id, idempotency_key, scope, source,
                payload, lease_worker_id, lease_version, lease_until, leased_at,
                attempts, max_attempts, not_before, failure, result_ref, created_at, updated_at
           FROM public.job_tasks WHERE task_id = $1`,
        [taskId],
      );
      const task = current[0];
      if (task === undefined) return { claimed: false, task: null, reason: 'NOT_FOUND' };
      const record = rowToRecord(task);
      if (
        record.status === TaskStatus.COMPLETED ||
        record.status === TaskStatus.MANUAL_INTERVENTION
      ) {
        return { claimed: false, task: record, reason: 'TERMINAL' };
      }
      if (record.lease !== null && new Date(record.lease.leaseUntil).getTime() > now.getTime()) {
        return { claimed: false, task: record, reason: 'LEASE_BUSY' };
      }
      return { claimed: false, task: record, reason: 'NOT_DUE' };
    });
  }

  async updateAfterExecution(
    taskId: string,
    expectedLeaseVersion: number,
    patch: TaskRecordPatch,
  ): Promise<TaskRecord | null> {
    return this.withTx(async (tx) => {
      const nowIso = patch.updatedAt ?? new Date().toISOString();
      const rows = await this.db.query<JobTaskRow>(
        tx,
        `UPDATE public.job_tasks
            SET status = COALESCE($3, status),
                attempts = COALESCE($4, attempts),
                failure = COALESCE($5::jsonb, failure),
                result_ref = COALESCE($6, result_ref),
                not_before = COALESCE($7, not_before),
                lease_worker_id = NULL,
                lease_version = NULL,
                lease_until = NULL,
                leased_at = NULL,
                updated_at = $8
          WHERE task_id = $1
            AND lease_version = $2
            AND status <> $9
          RETURNING task_id, task_type, status, intent_id, idempotency_key, scope, source,
                payload, lease_worker_id, lease_version, lease_until, leased_at,
                attempts, max_attempts, not_before, failure, result_ref, created_at, updated_at`,
        [
          taskId,
          expectedLeaseVersion,
          patch.status ?? null,
          patch.attempts ?? null,
          patch.failure === undefined ? null : JSON.stringify(patch.failure),
          patch.resultRef ?? null,
          patch.notBefore ?? null,
          nowIso,
          TaskStatus.COMPLETED,
        ],
      );
      if (rows[0] === undefined) {
        this.logger.warn(
          `任务状态更新未生效（旧租约/终态守卫未命中）：taskId=${taskId}, expectedLeaseVersion=${expectedLeaseVersion}`,
        );
        return null;
      }
      return rowToRecord(rows[0]);
    });
  }

  async listDueTaskIds(now: string, limit: number): Promise<readonly string[]> {
    return this.withTx(async (tx) => {
      const rows = await this.db.query<{ task_id: string }>(
        tx,
        `SELECT task_id FROM public.job_tasks
          WHERE status IN ${RUNNABLE_STATUSES} AND not_before <= $1
          ORDER BY not_before ASC
          LIMIT $2`,
        [now, limit],
      );
      return rows.map((row) => row.task_id);
    });
  }

  async listDeadlineTaskIds(before: string, limit: number): Promise<readonly string[]> {
    return this.withTx(async (tx) => {
      const rows = await this.db.query<{ task_id: string }>(
        tx,
        `SELECT task_id FROM public.job_tasks
          WHERE task_type = $1 AND not_before <= $2
          ORDER BY not_before ASC
          LIMIT $3`,
        [TaskType.DEADLINE, before, limit],
      );
      return rows.map((row) => row.task_id);
    });
  }

  async listExpiredLeaseTaskIds(now: string, limit: number): Promise<readonly string[]> {
    return this.withTx(async (tx) => {
      const rows = await this.db.query<{ task_id: string }>(
        tx,
        `SELECT task_id FROM public.job_tasks
          WHERE status = 'LEASED' AND lease_until IS NOT NULL AND lease_until <= $1
          ORDER BY lease_until ASC
          LIMIT $2`,
        [now, limit],
      );
      return rows.map((row) => row.task_id);
    });
  }

  async backlogSummary(): Promise<TaskBacklogSummary> {
    return this.withTx(async (tx) => {
      const rows = await this.db.query<{ status: string; count: string }>(
        tx,
        `SELECT status, COUNT(*) AS count
           FROM public.job_tasks
          GROUP BY status`,
        [],
      );
      const byStatus = new Map<string, number>();
      for (const row of rows) {
        byStatus.set(row.status, Number(row.count));
      }
      const perType: Record<TaskType, number> = Object.fromEntries(
        Object.values(TaskType).map((type) => [type, 0]),
      ) as Record<TaskType, number>;
      const typeRows = await this.db.query<{ task_type: string; count: string }>(
        tx,
        `SELECT task_type, COUNT(*) AS count
           FROM public.job_tasks
          GROUP BY task_type`,
        [],
      );
      for (const row of typeRows) {
        perType[row.task_type as TaskType] = Number(row.count);
      }
      return {
        pending: byStatus.get(TaskStatus.PENDING) ?? 0,
        leased: byStatus.get(TaskStatus.LEASED) ?? 0,
        retryableFailed: byStatus.get(TaskStatus.RETRYABLE_FAILED) ?? 0,
        uncertain: byStatus.get(TaskStatus.UNCERTAIN) ?? 0,
        manualIntervention: byStatus.get(TaskStatus.MANUAL_INTERVENTION) ?? 0,
        completed: byStatus.get(TaskStatus.COMPLETED) ?? 0,
        perType,
      };
    });
  }
}
