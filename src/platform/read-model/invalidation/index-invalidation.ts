import type { InvalidationEvent } from './invalidation-event';

/** 索引失效端口注入令牌（IndexInvalidationPort 为接口，注入须用显式 token） */
export const INDEX_INVALIDATION_PORT = Symbol('INDEX_INVALIDATION_PORT');

/**
 * 搜索索引失效端口（C4.2）。
 *
 * 由基础设施（PostgreSQL 全文/pg_trgm 检索索引）实现；本端口只负责
 * "使受影响权威对象的索引项失效"，索引**不得成为授权来源**
 * （IFC-DATA-012）：索引只影响检索范围与候选集，授权仍由服务端
 * 入口判定并逐对象重验。
 */
export interface IndexInvalidationPort {
  /**
   * 使受影响权威对象的索引项失效。
   * 幂等：同一事件重复调用不产生额外副作用（eventId 作为幂等依据）。
   */
  invalidate(event: InvalidationEvent): Promise<void>;
}
