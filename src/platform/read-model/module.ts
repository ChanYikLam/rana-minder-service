import { Module } from '@nestjs/common';
import { SearchNormalizer } from './derivation/search-normalizer';
import { VisibilityDerivationRules } from './derivation/visibility-derivation';
import { CacheInvalidationService } from './invalidation/invalidation-service';
import { InMemoryProjectionStore } from './projection/in-memory-projection-store';
import { ClubWorkbenchProjection } from './projection/club-workbench.projection';
import { PersonalCenterProjection } from './projection/personal-center.projection';
import { ProjectionRegistry } from './projection/projection-registry';
import { PROJECTION_STORE } from './projection/projection-store';
import { PublicDirectoryProjection } from './projection/public-directory.projection';
import { SourcePortRegistry } from './projection/source-port-registry';
import { ReadModelQueryService } from './query/query-service';
import { DerivedRebuildHandler } from './refresh/derived-rebuild-handler';
import { JobRecomputeIntentSink } from './refresh/job-recompute-intent-sink';
import { RECOMPUTE_INTENT_SINK } from './refresh/recompute-intent-sink';
import { RefreshHandler } from './refresh/refresh-handler';

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
 * 消费接力：refresh 消费领域对象 A 的 recompute（RecomputeIntent），
 * 只读领域权威对象（SourcePortRegistry 注入）；派生失败不改源业务。
 */
@Module({
  providers: [
    // 派生规则（纯函数服务）
    SearchNormalizer,
    VisibilityDerivationRules,
    // 投影脚手架
    ProjectionRegistry,
    SourcePortRegistry,
    { provide: PROJECTION_STORE, useClass: InMemoryProjectionStore },
    // 三个具体投影
    PublicDirectoryProjection,
    PersonalCenterProjection,
    ClubWorkbenchProjection,
    // 查询入口
    ReadModelQueryService,
    // 失效与刷新（消费接力）
    CacheInvalidationService,
    RefreshHandler,
    DerivedRebuildHandler,
    { provide: RECOMPUTE_INTENT_SINK, useClass: JobRecomputeIntentSink },
  ],
  exports: [
    ProjectionRegistry,
    SourcePortRegistry,
    ReadModelQueryService,
    CacheInvalidationService,
    RefreshHandler,
    DerivedRebuildHandler,
  ],
})
export class ReadModelModule {}
