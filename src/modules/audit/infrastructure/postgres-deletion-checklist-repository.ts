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
  readonly initiated_by: string;
  readonly initiated_at: Date;
  readonly confirmed: boolean;
  readonly affected_objects: unknown;
  readonly business_relations_ended: boolean;
  readonly steps: unknown;
  readonly completed: boolean;
  readonly replay_count: number;
  readonly version: number;
}

function toRow(c: DeletionChecklist): DeletionChecklistRow {
  return {
    checklist_id: c.checklistId,
    scope: JSON.stringify(c.scope),
    reason: c.reason,
    initiated_by: c.initiatedBy,
    initiated_at: new Date(c.initiatedAt),
    confirmed: c.confirmed,
    affected_objects: JSON.stringify(c.affectedObjects),
    business_relations_ended: c.businessRelationsEnded,
    steps: JSON.stringify(c.steps),
    completed: c.completed,
    replay_count: c.replayCount,
    version: c.version,
  };
}

function fromRow(r: DeletionChecklistRow): DeletionChecklist {
  return {
    checklistId: r.checklist_id,
    scope: JSON.parse(r.scope as string) as DeletionChecklist['scope'],
    reason: r.reason,
    initiatedBy: r.initiated_by,
    initiatedAt: (r.initiated_at as Date).toISOString(),
    confirmed: r.confirmed,
    affectedObjects: JSON.parse(r.affected_objects as string) as readonly string[],
    businessRelationsEnded: r.business_relations_ended,
    steps: JSON.parse(r.steps as string) as DeletionChecklist['steps'],
    completed: r.completed,
    replayCount: r.replay_count,
    version: r.version,
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
           checklist_id, scope, reason, initiated_by, initiated_at, confirmed,
           affected_objects, business_relations_ended, steps, completed, replay_count, version
         ) VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11, $12)`,
        [
          row.checklist_id,
          row.scope,
          row.reason,
          row.initiated_by,
          row.initiated_at,
          row.confirmed,
          row.affected_objects,
          row.business_relations_ended,
          row.steps,
          row.completed,
          row.replay_count,
          row.version,
        ],
      );
    });
  }

  async load(checklistId: string): Promise<DeletionChecklist | null> {
    return this.inTx(async (tx) => {
      const rows = await this.db.query<DeletionChecklistRow>(
        tx,
        `SELECT checklist_id, scope, reason, initiated_by, initiated_at, confirmed,
                affected_objects, business_relations_ended, steps, completed, replay_count, version
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
           scope = $2::jsonb, reason = $3, initiated_by = $4, initiated_at = $5,
           confirmed = $6, affected_objects = $7::jsonb, business_relations_ended = $8,
           steps = $9::jsonb, completed = $10, replay_count = $11, version = $12
         WHERE checklist_id = $1 AND version = $13`,
        [
          row.checklist_id,
          row.scope,
          row.reason,
          row.initiated_by,
          row.initiated_at,
          row.confirmed,
          row.affected_objects,
          row.business_relations_ended,
          row.steps,
          row.completed,
          row.replay_count,
          row.version,
          current.version,
        ],
      );
      return true;
    });
  }

  async listIncomplete(): Promise<readonly DeletionChecklist[]> {
    return this.listWhere('completed = false');
  }

  async listAll(): Promise<readonly DeletionChecklist[]> {
    return this.listWhere('');
  }

  private async listWhere(where: string): Promise<readonly DeletionChecklist[]> {
    return this.inTx(async (tx) => {
      const sql = `SELECT checklist_id, scope, reason, initiated_by, initiated_at, confirmed,
                          affected_objects, business_relations_ended, steps, completed, replay_count, version
                   FROM deletion_checklist${where.length > 0 ? ` WHERE ${where}` : ''}
                   ORDER BY initiated_at`;
      const rows = await this.db.query<DeletionChecklistRow>(tx, sql, []);
      return rows.map(fromRow);
    });
  }
}
