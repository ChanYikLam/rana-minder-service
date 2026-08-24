/**
 * 内存导出申请幂等存储桩（开发/单测放，5.4.2，IFC-ERR-009）。
 *
 * 同一 idempotencyKey：语义摘要一致 → 回放既有任务；不一致 → 冲突拒绝。
 * 生产环境需替换为带唯一约束/原子 upsert 的数据库实现。
 *
 * 并发/幂等回放约束：claim 必须是原子的（唯一约束或
 * select-for-update/upsert），避免并发下两请求同时读到空槽并都置 created 产生重复
 * 任务；release 用于落库失败时回滚槽位，避免槽位毒化。内存桩为串行 Map 非原子，
 * 仅作开发桩使用。
 */

import {
  APPLY_CONFLICT,
  EXPORT_APPLY_IDEMPOTENCY,
  type ApplyIdempotencyClaim,
  type ExportApplyIdempotencyPort,
} from '../application/ports/export-idempotency.port';

interface IdempotencySlot {
  readonly semanticHash: string;
  readonly taskId: string;
}

export class InMemoryExportIdempotency implements ExportApplyIdempotencyPort {
  private readonly slots = new Map<string, IdempotencySlot>();

  async claim(input: {
    key: string;
    semanticHash: string;
    taskId: string;
    now?: Date;
  }): Promise<ApplyIdempotencyClaim> {
    const prior = this.slots.get(input.key);
    if (prior === undefined) {
      this.slots.set(input.key, { semanticHash: input.semanticHash, taskId: input.taskId });
      return { status: 'created', taskId: input.taskId };
    }
    if (prior.semanticHash === input.semanticHash) {
      return { status: 'replayed', taskId: prior.taskId };
    }
    return { status: APPLY_CONFLICT };
  }

  async taskIdForKey(key: string): Promise<string | null> {
    return this.slots.get(key)?.taskId ?? null;
  }

  async hashForKey(key: string): Promise<string | null> {
    return this.slots.get(key)?.semanticHash ?? null;
  }

  async release(key: string, expectedTaskId: string): Promise<void> {
    const prior = this.slots.get(key);
    // 仅当槽位仍指向本调用创建的任务时才释放，避免并发下误删他人抢占的槽位。
    if (prior !== undefined && prior.taskId === expectedTaskId) {
      this.slots.delete(key);
    }
  }
}

export { EXPORT_APPLY_IDEMPOTENCY };
