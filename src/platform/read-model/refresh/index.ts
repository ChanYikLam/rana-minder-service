/**
 * 派生刷新/重建（refresh/）：消费"派生刷新/重建"任务（IFC-TX-008）。
 *
 * - recompute-intent-sink.ts        重算意图登记端口（invalidation 提交 → job 持久化）
 * - job-recompute-intent-sink.ts    job 登记实现（占位，待 job 模块接入）
 * - refresh-handler.ts              消费"A 的 recompute"执行投影刷新/重建
 * - derived-rebuild-handler.ts      对 job 模块暴露的"派生重算"任务处理器
 *
 * 消费接力：refresh 消费 A 的 recompute（RecomputeIntent）；只读领域权威对象，
 * 派生失败不改源业务，旧水位不覆盖新结果。
 */
export * from './recompute-intent-sink';
export * from './job-recompute-intent-sink';
export * from './refresh-handler';
export * from './derived-rebuild-handler';
