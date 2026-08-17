/**
 * 缓存/索引失效（invalidation/）：失效不得成为授权来源。
 *
 * - invalidation-event.ts 失效事件类型（IFC-QRY-009.9 触发面）
 * - invalidation-rule.ts  失效规则（投影类型 × 事件类型）
 * - invalidation-service.ts 失效服务（标记失效 + 登记重算意图）
 *
 * RecomputeIntentSink 定义于 refresh/（由 refresh 子包实现登记到 job）。
 */
export * from './invalidation-event';
export * from './invalidation-rule';
export * from './invalidation-service';
