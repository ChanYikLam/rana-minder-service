/**
 * PostgreSQL 删除执行清单仓储（infrastructure；IFC-TX-007、AUD-009）。
 *
 * 表 deletion_checklist（独立持久化；恢复备份后重新应用清单防复现）。
 *
 * - **独立持久化**：清单不可内存暂存——重启丢失将导致恢复重放失效（W2 评审意见）；
 * - **乐观锁 CAS**：compareAndSwap 在事务内 `SELECT ... FOR UPDATE` + 版本比较，
 *   并发执行只一个提交成功；
 * - DB 未连接（NotWired 桩）时方法失败关闭，绝不让清单丢失或并发失控。
 */

import type { DbAdapter, RlsScope, TransactionContext } from '../../../shared/db-adapter';
import type { DeletionChecklist } from '../domain/models/deletion';
import type { DeletionChecklistRepository } from './deletion-checklist-repository';

interface DeletionChecklistRow {
  readonly checklist_id: string;
  readonly scope: unknown;
  readonly reason: string;
  readonly purpose: string;
  readonly initiated_by: string;
  readonly initiated_at: Date;
  readonly confirmed: boolean;
  readonly affected_objects: unknown;
  readonly business_relations_ended: boolean;
  readonly steps: unknown;
  readonly completed: boolean;
  readonly replay_count: number;
  readonly retry_count: number;
  readonly needs_manual_review: boolean;
  readonly version: number;
  readonly audit_committed: boolean;
}

function toRow(c: DeletionChecklist): DeletionChecklistRow {
  return {
    checklist_id: c.checklistId,
    scope: JSON.stringify(c.scope),
    reason: c.reason,
    purpose: c.purpose,
    initiated_by: c.initiatedBy,
    initiated_at: new Date(c.initiatedAt),
    confirmed: c.confirmed,
    affected_objects: JSON.stringify(c.affectedObjects),
    business_relations_ended: c.businessRelationsEnded,
    steps: JSON.stringify(c.steps),
    completed: c.completed,
    replay_count: c.replayCount,
    retry_count: c.retryCount,
    needs_manual_review: c.needsManualReview,
    version: c.version,
    audit_committed: c.auditCommitted,
  };
}

function fromRow(r: DeletionChecklistRow): DeletionChecklist {
  return {
    checklistId: r.checklist_id,
    scope: JSON.parse(r.scope as string) as DeletionChecklist['scope'],
    reason: r.reason,
    purpose: r.purpose,
    initiatedBy: r.initiated_by,
    initiatedAt: new Date(r.initiated_at as Date | string).toISOString(),
    confirmed: r.confirmed,
    affectedObjects: JSON.parse(r.affected_objects as string) as readonly string[],
    businessRelationsEnded: r.business_relations_ended,
    steps: JSON.parse(r.steps as string) as DeletionChecklist['steps'],
    completed: r.completed,
    replayCount: r.replay_count,
    retryCount: r.retry_count,
    needsManualReview: r.needs_manual_review,
    version: r.version,
    auditCommitted: r.audit_committed,
  };
}

/** 删除清单 RLS 上下文（删除属平台级操作，使用无目标上下文） */
const SCOPE: RlsScope = { kind: 'unprotected' };

export class PostgresDeletionChecklistRepository implements DeletionChecklistRepository {
  constructor(private readonly db: DbAdapter) {}

  /** 独立事务内执行 fn（删除清单操作各自原子收口） */
  private async inTx<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const tx = await this.db.beginTransaction();
    try {
      await this.db.setRlsContext(tx, SCOPE);
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

  async save(checklist: DeletionChecklist): Promise<void> {
    const row = toRow(checklist);
    await this.inTx(async (tx) => {
      await this.db.query(
        tx,
        `INSERT INTO deletion_checklist (
           checklist_id, scope, reason, purpose, initiated_by, initiated_at, confirmed,
           affected_objects, business_relations_ended, steps, completed, replay_count, retry_count, needs_manual_review, version, audit_committed
         ) VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12, $13, $14, $15, $16)`,
        [
          row.checklist_id,
          row.scope,
          row.reason,
          row.purpose,
          row.initiated_by,
          row.initiated_at,
          row.confirmed,
          row.affected_objects,
          row.business_relations_ended,
          row.steps,
          row.completed,
          row.replay_count,
          row.retry_count,
          row.needs_manual_review,
          row.version,
          row.audit_committed,
        ],
      );
    });
  }

  async load(checklistId: string): Promise<DeletionChecklist | null> {
    return this.inTx(async (tx) => {
      const rows = await this.db.query<DeletionChecklistRow>(
        tx,
        `SELECT checklist_id, scope, reason, purpose, initiated_by, initiated_at, confirmed,
                affected_objects, business_relations_ended, steps, completed, replay_count, retry_count, needs_manual_review, version, audit_committed
         FROM deletion_checklist WHERE checklist_id = $1`,
        [checklistId],
      );
      return rows.length > 0 ? fromRow(rows[0]) : null;
    });
  }

  /** 乐观锁提交：事务内锁行 + 版本比较，并发只一个成功（W1/W2） */
  async compareAndSwap(current: DeletionChecklist, next: DeletionChecklist): Promise<boolean> {
    const row = toRow(next);
    return this.inTx(async (tx) => {
      const locked = await this.db.query<{ version: number }>(
        tx,
        `SELECT version FROM deletion_checklist WHERE checklist_id = $1 FOR UPDATE`,
        [next.checklistId],
      );
      if (locked.length === 0 || locked[0].version !== current.version) {
        return false;
      }
      await this.db.query(
        tx,
        `UPDATE deletion_checklist SET
           scope = $2::jsonb, reason = $3, purpose = $4, initiated_by = $5, initiated_at = $6,
           confirmed = $7, affected_objects = $8::jsonb, business_relations_ended = $9,
           steps = $10::jsonb, completed = $11, replay_count = $12, retry_count = $13,
           needs_manual_review = $16, version = $14, audit_committed = $15
         -- WHERE version 为防御性双重校验：前方 SELECT ... FOR UPDATE 已锁行并校验版本，
         -- 但保留条件使非锁内（异常/直连）UPDATE 也不会覆盖并发写入的较新版本
         WHERE checklist_id = $1 AND version = $17`,
        [
          row.checklist_id,
          row.scope,
          row.reason,
          row.purpose,
          row.initiated_by,
          row.initiated_at,
          row.confirmed,
          row.affected_objects,
          row.business_relations_ended,
          row.steps,
          row.completed,
          row.replay_count,
          row.retry_count,
          row.version,
          row.audit_committed,
          row.needs_manual_review,
          current.version,
        ],
      );
      return true;
    });
  }

  async listIncomplete(): Promise<readonly DeletionChecklist[]> {
    // 排除需人工介入清单（达重试上限），重试任务不再拉取空转（warning 评审意见）
    return this.listWhere('completed = false AND needs_manual_review = false');
  }

  async listAll(): Promise<readonly DeletionChecklist[]> {
    return this.listWhere('');
  }

  private async listWhere(where: string): Promise<readonly DeletionChecklist[]> {
    return this.inTx(async (tx) => {
      const sql = `SELECT checklist_id, scope, reason, purpose, initiated_by, initiated_at, confirmed,
                          affected_objects, business_relations_ended, steps, completed, replay_count,
                          retry_count, needs_manual_review, version, audit_committed
                   FROM deletion_checklist${where.length > 0 ? ` WHERE ${where}` : ''}
                   ORDER BY initiated_at`;
      const rows = await this.db.query<DeletionChecklistRow>(tx, sql, []);
      return rows.map(fromRow);
    });
  }
}
