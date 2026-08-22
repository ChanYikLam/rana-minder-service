/**
 * PostgreSQL 平台任务仓储（platform/tasks；T1 接线）。
 *
 * 依据：ADR-004（租约执行单元）、DATA-CON-006（原子竞争/幂等）、SEC-VER-011
 * （旧租约令牌提交必须失败）。
 *
 * 表 task_records（迁移 20260822100000）：
 *   task_id text PK / task_type / status / intent_id / idempotency_key /
 *   scope jsonb / source jsonb / payload jsonb / lease jsonb /
 *   attempts / max_attempts / not_before / failure jsonb / result_ref /
 *   created_at / updated_at
 *
 * 语义：
 * - 领取 = 单条 UPDATE ... RETURNING 原子单胜者（排除终态 + 有效租约占用 +
 *   到期可执行），并发 worker 只有单胜者；
 * - 完成/收口带 lease_version 守卫，旧租约令牌提交必须失败；
 * - 租约到期可重领；耗尽尝试数任务转 MANUAL_INTERVENTION 防卡死；
 * - 每笔操作在事务内建立并清理最小 RLS 上下文（平台级 unprotected）。
 */

import { Injectable, Logger } from '@nestjs/common';

import type { DbAdapter, RlsScope, TransactionContext } from '../../shared/db-adapter';
import { deriveTrackingNumber } from './contracts/task-intent';
import { TaskStatus, isTerminalTaskStatus } from './contracts/task-status';
import type { TaskIntent } from './contracts/task-intent';
import type { TaskRecord, TaskRecordPatch, TaskLease, TaskFailure } from './contracts/task-record';
import type { TaskBacklogSummary, TaskClaimResult, TaskRepository } from './contracts/task-ports';
import { TaskType } from './contracts/task-type';

// 说明：pg 驱动会将 jsonb 列自动解析为 JS 对象返回（非 JSON 字符串），
// 因此 TaskRecordRow 中 jsonb 字段（scope/source/payload/lease/failure）
// 直接以对象形式读取，无需（也不应）再 JSON.parse。
interface TaskRecordRow {
  task_id: string;
  task_type: string;
  status: string;
  intent_id: string;
  idempotency_key: string;
  scope: unknown;
  source: unknown;
  payload: unknown;
  lease: unknown | null;
  attempts: number;
  max_attempts: number;
  not_before: string;
  failure: unknown | null;
  result_ref: string | null;
  created_at: string;
  updated_at: string;
}

const RLS_UNPROTECTED: RlsScope = { kind: 'unprotected' };

function rowToRecord(row: TaskRecordRow): TaskRecord {
  return {
    taskId: row.task_id,
    taskType: row.task_type as TaskType,
    status: row.status as TaskStatus,
    intentId: row.intent_id,
    idempotencyKey: row.idempotency_key,
    scope: row.scope as TaskRecord['scope'],
    source: row.source as TaskRecord['source'],
    payload: row.payload as TaskRecord['payload'],
    lease: (row.lease as TaskLease | null) ?? null,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    // pg 将 timestamptz 列默认解析为 Date 对象；统一规范为 ISO 字符串以符合 TaskRecord 契约。
    notBefore: new Date(row.not_before).toISOString(),
    failure: (row.failure as TaskFailure | null) ?? null,
    resultRef: row.result_ref,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** 任务记录查询字段（与表列一一对应）。 */
const RECORD_COLUMNS = `task_id, task_type, status, intent_id, idempotency_key,
  scope, source, payload, lease, attempts, max_attempts, not_before,
  failure, result_ref, created_at, updated_at`;

/** 带表别名 t. 的列清单：用于 UPDATE ... FROM（RETURNING 需消歧义）。 */
const RECORD_COLUMNS_ALIASED = RECORD_COLUMNS.split(',')
  .map((col) => `t.${col.trim()}`)
  .join(', ');

@Injectable()
export class PostgresTaskRepository implements TaskRepository {
  private readonly logger = new Logger(PostgresTaskRepository.name);

  constructor(private readonly db: DbAdapter) {}

  /** 开启一个平台级（unprotected）事务会话，执行完回调后收口并清理。 */
  private async withSession<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const tx = await this.db.beginTransaction();
    await this.db.setRlsContext(tx, RLS_UNPROTECTED);
    try {
      const result = await fn(tx);
      await this.db.commit(tx);
      return result;
    } catch (err) {
      await this.db.rollback(tx);
      throw err;
    } finally {
      await this.db.clearRlsContext(tx);
    }
  }

  async insert(intent: TaskIntent): Promise<TaskRecord> {
    const existing = await this.findByIntentId(intent.intentId);
    if (existing !== null) return existing;

    const taskId = deriveTrackingNumber(intent.intentId, intent.taskType);
    const row: TaskRecordRow = {
      task_id: taskId,
      task_type: intent.taskType,
      status: TaskStatus.PENDING,
      intent_id: intent.intentId,
      idempotency_key: intent.idempotencyKey,
      scope: JSON.stringify(intent.scope),
      source: JSON.stringify(intent.source),
      payload: JSON.stringify(intent.payload),
      lease: null,
      attempts: 0,
      max_attempts: 5,
      not_before: intent.notBefore,
      failure: null,
      result_ref: null,
      created_at: intent.createdAt,
      updated_at: intent.createdAt,
    };

    return this.withSession(async (tx) => {
      const rows = await this.db.query<TaskRecordRow>(
        tx,
        `INSERT INTO task_records (${RECORD_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12::timestamptz,$13,$14,$15::timestamptz,$16::timestamptz)
         ON CONFLICT (intent_id) DO NOTHING
         RETURNING ${RECORD_COLUMNS}`,
        [
          row.task_id,
          row.task_type,
          row.status,
          row.intent_id,
          row.idempotency_key,
          row.scope,
          row.source,
          row.payload,
          row.lease,
          row.attempts,
          row.max_attempts,
          row.not_before,
          row.failure,
          row.result_ref,
          row.created_at,
          row.updated_at,
        ],
      );
      const inserted = rows[0];
      if (inserted) return rowToRecord(inserted);
      // 并发下被其他事务插入：读回既有记录
      const existingRow = await this.findById(tx, taskId);
      return existingRow!;
    });
  }

  async findById(
    tx: TransactionContext | string,
    maybeTaskId?: string,
  ): Promise<TaskRecord | null> {
    if (typeof tx === 'string') {
      const taskId = tx;
      return this.withSession(async (t) => {
        const rows = await this.db.query<TaskRecordRow>(
          t,
          `SELECT ${RECORD_COLUMNS} FROM task_records WHERE task_id = $1`,
          [taskId],
        );
        return rows[0] ? rowToRecord(rows[0]) : null;
      });
    }
    const taskId = maybeTaskId!;
    const rows = await this.db.query<TaskRecordRow>(
      tx,
      `SELECT ${RECORD_COLUMNS} FROM task_records WHERE task_id = $1`,
      [taskId],
    );
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  async findByIntentId(intentId: string): Promise<TaskRecord | null> {
    return this.withSession(async (tx) => {
      const rows = await this.db.query<TaskRecordRow>(
        tx,
        `SELECT ${RECORD_COLUMNS} FROM task_records WHERE intent_id = $1`,
        [intentId],
      );
      return rows[0] ? rowToRecord(rows[0]) : null;
    });
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<TaskRecord | null> {
    return this.withSession(async (tx) => {
      const rows = await this.db.query<TaskRecordRow>(
        tx,
        `SELECT ${RECORD_COLUMNS} FROM task_records WHERE idempotency_key = $1`,
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
    return this.withSession(async (tx) => {
      const nowIso = now.toISOString();
      // 单条 UPDATE ... RETURNING 原子单胜者：排除终态、有效租约占用、未到期任务。
      const rows = await this.db.query<TaskRecordRow>(
        tx,
        `UPDATE task_records t
            SET status = $2,
                lease = $3::jsonb,
                attempts = t.attempts,
                updated_at = $4::timestamptz
           FROM (
                  SELECT task_id
                    FROM task_records
                   WHERE task_id = $1
                     AND status IN ('PENDING', 'RETRYABLE_FAILED', 'UNCERTAIN', 'LEASED')
                     AND (lease IS NULL OR (lease->>'leaseUntil')::timestamptz <= $4::timestamptz)
                     AND not_before <= $4::timestamptz
                ) c
          WHERE t.task_id = c.task_id
          RETURNING ${RECORD_COLUMNS_ALIASED}`,
        [
          taskId,
          TaskStatus.LEASED,
          JSON.stringify({
            workerId,
            leaseVersion,
            leaseUntil,
            leasedAt: nowIso,
          }),
          nowIso,
        ],
      );
      const row = rows[0];
      if (row) return { claimed: true, task: rowToRecord(row) };

      // 未领到：区分原因
      const current = await this.findById(tx, taskId);
      if (current === null) return { claimed: false, task: null, reason: 'NOT_FOUND' };
      if (isTerminalTaskStatus(current.status)) {
        return { claimed: false, task: current, reason: 'TERMINAL' };
      }
      if (current.lease !== null && new Date(current.lease.leaseUntil).getTime() > now.getTime()) {
        return { claimed: false, task: current, reason: 'LEASE_BUSY' };
      }
      return { claimed: false, task: current, reason: 'NOT_DUE' };
    });
  }

  async updateAfterExecution(
    taskId: string,
    expectedLeaseVersion: number,
    patch: TaskRecordPatch,
  ): Promise<TaskRecord | null> {
    return this.withSession(async (tx) => {
      const rows = await this.db.query<TaskRecordRow>(
        tx,
        `UPDATE task_records
            SET status = COALESCE($2, status),
                lease = COALESCE($3::jsonb, lease),
                attempts = COALESCE($4, attempts),
                failure = COALESCE($5::jsonb, failure),
                result_ref = COALESCE($6, result_ref),
                not_before = COALESCE($7::timestamptz, not_before),
                updated_at = COALESCE($8::timestamptz, updated_at)
          WHERE task_id = $1
            AND (lease->>'leaseVersion')::int = $9
          RETURNING ${RECORD_COLUMNS}`,
        [
          taskId,
          patch.status ?? null,
          patch.lease ? JSON.stringify(patch.lease) : null,
          patch.attempts ?? null,
          patch.failure ? JSON.stringify(patch.failure) : null,
          patch.resultRef ?? null,
          patch.notBefore ?? null,
          patch.updatedAt ?? new Date().toISOString(),
          expectedLeaseVersion,
        ],
      );
      const row = rows[0];
      return row ? rowToRecord(row) : null;
    });
  }

  async listDueTaskIds(now: string, limit: number): Promise<readonly string[]> {
    return this.withSession(async (tx) => {
      const rows = await this.db.query<{ task_id: string }>(
        tx,
        `SELECT task_id FROM task_records
          WHERE status IN ('PENDING', 'RETRYABLE_FAILED')
            AND not_before <= $1::timestamptz
          ORDER BY created_at, task_id
          LIMIT $2`,
        [now, limit],
      );
      return rows.map((r) => r.task_id);
    });
  }

  async listDeadlineTaskIds(before: string, limit: number): Promise<readonly string[]> {
    return this.withSession(async (tx) => {
      const rows = await this.db.query<{ task_id: string }>(
        tx,
        `SELECT task_id FROM task_records
          WHERE task_type = 'DEADLINE'
            AND not_before <= $1::timestamptz
          ORDER BY created_at, task_id
          LIMIT $2`,
        [before, limit],
      );
      return rows.map((r) => r.task_id);
    });
  }

  async listExpiredLeaseTaskIds(now: string, limit: number): Promise<readonly string[]> {
    return this.withSession(async (tx) => {
      const rows = await this.db.query<{ task_id: string }>(
        tx,
        `SELECT task_id FROM task_records
          WHERE status = 'LEASED'
            AND lease IS NOT NULL
            AND (lease->>'leaseUntil')::timestamptz <= $1::timestamptz
          ORDER BY created_at, task_id
          LIMIT $2`,
        [now, limit],
      );
      return rows.map((r) => r.task_id);
    });
  }

  async backlogSummary(): Promise<TaskBacklogSummary> {
    return this.withSession(async (tx) => {
      const perType: Record<TaskType, number> = Object.fromEntries(
        Object.values(TaskType).map((type) => [type, 0]),
      ) as Record<TaskType, number>;

      const statusRows = await this.db.query<{ status: string; cnt: string }>(
        tx,
        `SELECT status, count(*)::text AS cnt FROM task_records GROUP BY status`,
        [],
      );
      const typeRows = await this.db.query<{ task_type: string; cnt: string }>(
        tx,
        `SELECT task_type, count(*)::text AS cnt FROM task_records GROUP BY task_type`,
        [],
      );

      const byStatus: Record<string, number> = {};
      for (const r of statusRows) byStatus[r.status] = Number(r.cnt);
      for (const r of typeRows) perType[r.task_type as TaskType] = Number(r.cnt);

      return {
        pending: byStatus[TaskStatus.PENDING] ?? 0,
        leased: byStatus[TaskStatus.LEASED] ?? 0,
        retryableFailed: byStatus[TaskStatus.RETRYABLE_FAILED] ?? 0,
        uncertain: byStatus[TaskStatus.UNCERTAIN] ?? 0,
        manualIntervention: byStatus[TaskStatus.MANUAL_INTERVENTION] ?? 0,
        completed: byStatus[TaskStatus.COMPLETED] ?? 0,
        perType,
      };
    });
  }
}
