/**
 * 投影脚手架（projection/）：投影的持久化载体、构建器、注册表与具体投影。
 *
 * - projection-store.ts             投影持久化载体接口（可替换）
 * - in-memory-projection-store.ts   进程内可重建存储（ADR-007 占位）
 * - projection-builder.ts           投影构建器（权威源 + 派生规则 → 重建投影）
 * - projection-registry.ts          投影类型注册表
 * - source-port-registry.ts         权威源端口注册表（领域模块注入只读端口）
 * - public-directory/               公开目录子规则：find-club（C6.1）/ find-activity（C6.2）
 * - public-directory.projection.ts  公开目录投影（找社团/找活动）
 * - personal-center.projection.ts   全局个人中心投影
 * - club-workbench.projection.ts    当前社团管理工作台投影
 */
export * from './projection-store';
export * from './in-memory-projection-store';
export * from './projection-builder';
export * from './projection-registry';
export * from './source-port-registry';
export * from './public-directory/find-club';
export * from './public-directory/find-activity';
export * from './public-directory.projection';
export * from './personal-center.projection';
export * from './club-workbench.projection';
