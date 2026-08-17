/**
 * 投影契约（contracts/）：read-model 的共享类型与抽象端口。
 *
 * - projection-type.ts     投影类型与格式版本
 * - scope.ts               投影作用域（社团/协作域/主体/访问者）
 * - source-ref.ts          权威源对象引用
 * - watermark.ts           派生水位
 * - projection-record.ts   投影记录信封（DATA-DER-001）
 * - authoritative-source.ts 权威源只读端口（领域模块实现）
 * - recompute-intent.ts    派生重算意图（refresh 消费）
 * - authorization-port.ts  对象级授权端口（C6.9-C6.11 逐对象重验接线）
 * - ops-telemetry-port.ts  ops 遥测端口（C5.3 技术证据）
 */
export * from './projection-type';
export * from './scope';
export * from './source-ref';
export * from './watermark';
export * from './projection-record';
export * from './authoritative-source';
export * from './recompute-intent';
export * from './authorization-port';
export * from './ops-telemetry-port';
