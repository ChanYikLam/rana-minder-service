/**
 * 只读查询入口（query/）：服务端授权后投影。
 *
 * - query-context.ts 查询授权上下文（承接组织模块的授权判定结果）
 * - query-options.ts 查询选项（IFC-QRY-002/008 筛选/游标/分页约束）
 * - query-result.ts  派生查询结果（来源/水位/游标）
 * - query-service.ts 查询编排（授权 → 读投影 → 回源或明确不可用）
 * - entry-registry.ts 入口登记目录（IFC-QRY-008：入口版本/筛选键/值类型/排序/分页）
 * - directory-query.ts 公开目录查询入口（C3.1，匿名可读）
 * - me-query.ts        个人中心查询入口（C3.2，只聚合本人）
 * - workbench-query.ts 工作台查询入口（C3.3，固定当前社团）
 */
export * from './query-context';
export * from './query-options';
export * from './query-result';
export * from './query-service';
export * from './entry-registry';
export * from './directory-query';
export * from './me-query';
export * from './workbench-query';
