/**
 * 领域模块：统计与导出（stat-export）。
 *
 * 当前实现 5.4.1 统计口径与权限，包含：
 * - StatisticsSpecification 纯规则（统计口径规范 + 导出字段基线）；
 * - StatisticsSource 内存桩（只读回源事实）；
 * - MemoryStatisticsAuthorizationPort / InMemoryStatisticsAuditPort（开发授权与审计桩）；
 * - 3 个查询用例：ClubStatisticsQuery、RecruitmentFunnelQuery、JointActivityStatisticsQuery；
 * - StatisticsController（社团侧＋平台侧统计端点，汇总/下钻分离）。
 *
 * 导出（5.4.2~5.4.4）将注入 STATISTICS_SPECIFICATION 复用同一口径基线。
 *
 * 门禁说明（评审提醒，非阻塞）：
 * - MemoryStatisticsAuthorizationPort 采用 fail-closed 开发门禁（须 NODE_ENV=dev|test
 *   且 ORG_DEV_ACTOR_HEADER=1），生产装配即抛错（GOV-007），与 organization 模块一致；
 * - 身份模块接线落地前，生产环境统计端点整体不可达（属有意为之）——
 *   上线前须以真实身份/授权实现替换 STATISTICS_AUTHORIZATION_PORT 与
 *   STATISTICS_SOURCE（正式业务记录投影），并接通统计访问审计落库。
 */

import { Module } from '@nestjs/common';

import { StatisticsSpecification } from './domain/models/statistics-specification';
import { STATISTICS_SOURCE } from './application/ports/statistics-source.port';
import {
  STATISTICS_AUTHORIZATION_PORT,
  STATISTICS_AUDIT_PORT,
} from './application/ports/statistics-authorization.port';
import { InMemoryStatisticsSource } from './infrastructure/in-memory-statistics-source';
import {
  InMemoryStatisticsAuditPort,
  MemoryStatisticsAuthorizationPort,
} from './infrastructure/memory-statistics-access';
import { ClubStatisticsQuery } from './application/queries/club-statistics.query';
import { RecruitmentFunnelQuery } from './application/queries/recruitment-funnel.query';
import { JointActivityStatisticsQuery } from './application/queries/joint-activity-statistics.query';
import { StatisticsController } from './interfaces/http/statistics.controller';

// Token for the specification — used by export module (5.4.2~5.4.4) via DI
export const STATISTICS_SPECIFICATION = Symbol('STATISTICS_SPECIFICATION');

@Module({
  controllers: [StatisticsController],
  providers: [
    // 领域规则（纯规则 singleton）
    StatisticsSpecification,
    { provide: STATISTICS_SPECIFICATION, useExisting: StatisticsSpecification },

    // 基础设施端口（内存桩，后续替换为 PostgreSQL 实现）
    { provide: STATISTICS_SOURCE, useClass: InMemoryStatisticsSource },
    {
      provide: STATISTICS_AUTHORIZATION_PORT,
      useFactory: () => new MemoryStatisticsAuthorizationPort({}),
    },
    { provide: STATISTICS_AUDIT_PORT, useClass: InMemoryStatisticsAuditPort },

    // 应用查询用例
    ClubStatisticsQuery,
    RecruitmentFunnelQuery,
    JointActivityStatisticsQuery,
  ],
  exports: [
    // 导出模块（5.4.2~5.4.4）与统计共享口径基线
    STATISTICS_SPECIFICATION,
    STATISTICS_SOURCE,
    // 查询用例供其他模块或 worker 调用
    ClubStatisticsQuery,
    RecruitmentFunnelQuery,
    JointActivityStatisticsQuery,
  ],
})
export class StatExportModule {}
