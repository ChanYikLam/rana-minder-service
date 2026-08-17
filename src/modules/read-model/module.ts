import { Module } from '@nestjs/common';

/**
 * 平台支撑模块：派生入口与读模型（ADR-002 §2.2）。
 *
 * 职责：公开目录、全局个人中心、当前社团管理工作台的可重建投影；
 * 不拥有业务状态，不从缓存/投影授权（IFC-DATA-012）。
 *
 * 目录组织（功能子域）：
 * - contracts/    投影契约、水位、作用域与权威源抽象
 * - projection/   投影脚手架与三个具体投影（public-directory/personal-center/club-workbench）
 * - derivation/   从权威对象派生（纯规则，不做个性化推荐）
 * - query/        只读查询入口（服务端授权后投影）
 * - invalidation/ 缓存/索引失效（不得成为授权来源）
 * - refresh/      消费"派生刷新/重建"任务（IFC-TX-008，经 job 持久化任务）
 *
 * 子任务按序落地：contracts → projection+derivation → query →
 * invalidation → refresh → 三个具体投影。
 */
@Module({})
export class ReadModelModule {}
