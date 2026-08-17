import type { ProjectionType } from './projection-type';
import type { SourceRef } from './source-ref';

/**
 * 派生重算触发原因。
 *
 * 对应 IFC-QRY-009.9 的失效触发面：权限收紧、状态变化、社团停用、
 * 联合参与失效、字段权限变化或正式删除必须使相关缓存、索引、
 * 旧详情和旧游标失效。
 */
export const RecomputeReason = {
  /** 源状态/版本变化 */
  SOURCE_STATE_CHANGED: 'SOURCE_STATE_CHANGED',
  /** 正式删除（IFC-TX-007 删除清单覆盖派生记录） */
  SOURCE_DELETED: 'SOURCE_DELETED',
  /** 可见范围收紧/失权（权限收紧） */
  SCOPE_TIGHTENED: 'SCOPE_TIGHTENED',
  /** 字段权限变化（字段投影收紧） */
  FIELD_PERMISSION_CHANGED: 'FIELD_PERMISSION_CHANGED',
  /** 社团停用 */
  CLUB_DISABLED: 'CLUB_DISABLED',
  /** 联合参与失效 */
  UNION_WITHDRAWN: 'UNION_WITHDRAWN',
  /** 显式重建（人工触发/恢复重放，IFC-CMD-005 重建命令） */
  REBUILD_REQUESTED: 'REBUILD_REQUESTED',
} as const;

export type RecomputeReason = (typeof RecomputeReason)[keyof typeof RecomputeReason];

/**
 * 派生重算意图（refresh 子包消费的"A 的 recompute"）。
 *
 * 权威对象 A 发生变更（状态/版本/作用域/删除/权限收紧）后，
 * 由领域模块或变更钩子登记重算意图；job 模块的"派生重算"任务
 * （DerivedRebuildHandler，IFC-TX-008）消费该意图，调用 read-model
 * 刷新处理器执行投影刷新/重建。intentId 同时作为幂等依据。
 */
export interface RecomputeIntent {
  /** 意图唯一标识（幂等依据；job 任务/重试共享同一标识） */
  readonly intentId: string;
  /** 源权威对象 */
  readonly source: SourceRef;
  /** 触发原因 */
  readonly reason: RecomputeReason;
  /** 期望处理的投影类型（缺省=该源涉及的全部投影） */
  readonly targetProjections?: readonly ProjectionType[];
  /** 登记时间（服务端可信时钟，ISO 8601） */
  readonly createdAt: string;
}
