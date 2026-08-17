/**
 * 只读查询入口（query/）：服务端授权后投影。
 *
 * - query-context.ts 查询授权上下文（承接组织模块的授权判定结果）
 * - query-options.ts 查询选项（IFC-QRY-002/008 筛选/游标/分页约束）
 * - query-result.ts  派生查询结果（来源/水位/游标）
 * - query-service.ts 查询编排（授权 → 读投影 → 回源或明确不可用）
 */
export * from './query-context';
export * from './query-options';
export * from './query-result';
export * from './query-service';
