import type { ProjectionScope, SourceRef } from '../contracts';

/**
 * 缓存/索引失效事件类型（IFC-QRY-009.9 触发面）。
 *
 * 权限收紧、状态变化、社团停用、联合参与失效、字段权限变化或正式删除
 * 必须使相关缓存、索引、旧详情和旧游标失效；失效后不得返回新鲜结果，
 * 只能安全回源、转可追踪异步任务或明确不可用。
 */
export const InvalidationEventType = {
  /** 权限收紧/失权 */
  PERMISSION_TIGHTENED: 'PERMISSION_TIGHTENED',
  /** 源状态变化 */
  SOURCE_STATE_CHANGED: 'SOURCE_STATE_CHANGED',
  /** 社团停用 */
  CLUB_DISABLED: 'CLUB_DISABLED',
  /** 联合参与失效 */
  UNION_WITHDRAWN: 'UNION_WITHDRAWN',
  /** 字段权限变化 */
  FIELD_PERMISSION_CHANGED: 'FIELD_PERMISSION_CHANGED',
  /** 正式删除（IFC-TX-007 删除清单覆盖派生记录） */
  SOURCE_DELETED: 'SOURCE_DELETED',
} as const;

export type InvalidationEventType =
  (typeof InvalidationEventType)[keyof typeof InvalidationEventType];

/**
 * 失效事件。
 */
export interface InvalidationEvent {
  /** 事件唯一标识（幂等；重复事件不重复失效） */
  readonly eventId: string;
  readonly type: InvalidationEventType;
  /** 受影响权威对象 */
  readonly source: SourceRef;
  /** 受影响作用域 */
  readonly scope: ProjectionScope;
  /** 发生时间（服务端可信时钟，ISO 8601） */
  readonly occurredAt: string;
}
