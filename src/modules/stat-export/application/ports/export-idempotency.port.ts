/**
 * 导出申请幂等存储端口（5.4.2，IFC-ERR-009 幂等语义）。
 *
 * 同一 idempotencyKey 语义摘要一致 → 回放既有任务（幂等、不重复建任务与快照）；
 * 语义摘要不一致 → 冲突拒绝（IFC-ERR-009）。语义摘要由命令层从"申请作用域/字段/数据集"
 * 归一化计算，请求客户端 key 与摘要严格分离。
 */

export const APPLY_CONFLICT = 'APPLY_CONFLICT' as const;

export type ApplyIdempotencyClaim =
  | { status: 'created'; taskId: string }
  | { status: 'replayed'; taskId: string }
  | { status: typeof APPLY_CONFLICT };

export interface ExportApplyIdempotencyPort {
  /** 原子领取幂等槽位；key 已存在且语义一致 → 回放，不一致 → 冲突 */
  claim(input: {
    key: string;
    semanticHash: string;
    taskId: string;
    now?: Date;
  }): Promise<ApplyIdempotencyClaim>;
  /** 幂等回放后读回已创建任务 id */
  taskIdForKey(key: string): Promise<string | null>;
  /** 该幂等键已登记的语义摘要（无则 null；用于回放前判断同键是否语义一致） */
  hashForKey(key: string): Promise<string | null>;

  /**
   * 释放/回滚幂等槽位。
   *
   * 幂等槽位领取（claim=created）与任务落库并非同一事务，若 `repo.save` 失败而槽位
   * 仍指向不存在的任务，后续同 key 重试会命中 replayed 但 load 为 null → 永久毒化。
   * 因此在落库失败时回滚槽位。
   *
   * 仅当槽位仍指向 `expectedTaskId` 时才释放，避免并发下误删他人已抢占的槽位。
   * 生产实现中，幂等槽位与任务落库应在同一事务（DB 唯一约束 + 任务同事务写入）内
   * 原子提交，无需此补偿；此处为内存桩提供的幂等回滚钩子。
   */
  release(key: string, expectedTaskId: string): Promise<void>;
}

export const EXPORT_APPLY_IDEMPOTENCY = Symbol('EXPORT_APPLY_IDEMPOTENCY');
