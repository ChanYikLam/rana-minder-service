/**
 * 领域模块：统计与导出（stat-export）。
 *
 * 5.4.1 统计口径与权限 + 5.4.2 导出权限边界。
 *
 * 统计层：
 * - StatisticsSpecification 纯规则（统计口径规范 + 导出字段基线）；
 * - StatisticsSource 内存桩（只读回源事实）；
 * - MemoryStatisticsAuthorizationPort / InMemoryStatisticsAuditPort（开发授权与审计桩）；
 * - 3 个查询用例：ClubStatisticsQuery、RecruitmentFunnelQuery、JointActivityStatisticsQuery；
 * - StatisticsController（社团侧＋平台侧统计端点，汇总/下钻分离）。
 *
 * 导出层（5.4.2 EXP-001/003、JNT-023、AUD-009、GOV-004；5.4.4 异步生成与有效期）：
 * - ExportApplyCommand / ExportRetryCommand / ExportDeleteCommand 三类命令；
 * - 5.4.4：ExportGenerationCommand（后台 worker 驱动的异步生成管线，EXP-001/002/003）
 *   与 ExportExpirySweepCommand（有效期收敛 + 对象存储清理），导出供 TasksModule 装配；
 * - ExportAuthorizationPort 区分 5 类导出者（社团负责人/人事、部门负责人、普通面试官、
 *   普通成员/申请人、平台超管）；
 * - ExportFactSourcePort / ExportDownloadFilePort / ExportApplyIdempotencyPort /
 *   ExportTaskRepository / 数据集回源·文件写出·处置·通知·有效期配置 等基础设施端口
 *   （内存桩）；
 * - ExportController 申请/重试/提前删除/状态轮询/下载端点；
 * - 与统计共享 STATISTICS_SPECIFICATION 口径基线，"统计口径 = 导出口径"。
 *
 * 门禁说明：
 * - MemoryStatisticsAuthorizationPort / MemoryExportAuthorizationPort 采用 fail-closed
 *   开发门禁（须 NODE_ENV=dev|test 且 ORG_DEV_ACTOR_HEADER=1），生产装配即抛错（GOV-007）。
 * - 生产环境下用 ProductionFailClosed* 空作用域桩，避免 GOV-007 使整个应用无法启动——
 *   所有用户解析为空作用域/普通成员，请求被拒（fail-closed），待真实实现替换后再放权。
 * - 身份模块接线落地前，生产环境统计/导出端点整体不可达（属有意为之）。
 */

import { Module } from '@nestjs/common';

import { StatisticsSpecification } from './domain/models/statistics-specification';
import { STATISTICS_SOURCE } from './application/ports/statistics-source.port';
import {
  STATISTICS_AUTHORIZATION_PORT,
  STATISTICS_AUDIT_PORT,
  type StatisticsAuthorizationPort,
  type StatisticsPrincipal,
} from './application/ports/statistics-authorization.port';
import { InMemoryStatisticsSource } from './infrastructure/in-memory-statistics-source';
import {
  InMemoryStatisticsAuditPort,
  MemoryStatisticsAuthorizationPort,
  buildMemoryStatisticsAuthorizationSeedFromEnv,
} from './infrastructure/memory-statistics-access';
import { ClubStatisticsQuery } from './application/queries/club-statistics.query';
import { RecruitmentFunnelQuery } from './application/queries/recruitment-funnel.query';
import { JointActivityStatisticsQuery } from './application/queries/joint-activity-statistics.query';
import { StatisticsController } from './interfaces/http/statistics.controller';
import {
  EXPORT_AUTHORIZATION_PORT,
  EXPORT_AUDIT_PORT,
  EXPORT_REAUTH_PORT,
  EXPORT_SAFETY_SWITCH_PORT,
  type ExportAuthorizationPort,
  type ExportPrincipal,
} from './application/ports/export-authorization.port';
import { EXPORT_TASK_REPOSITORY } from './application/ports/export-repository.port';
import { EXPORT_FACT_SOURCE } from './application/ports/export-fact-source.port';
import { EXPORT_DOWNLOAD_FILE_PORT } from './application/ports/export-file-access.port';
import { EXPORT_APPLY_IDEMPOTENCY } from './application/ports/export-idempotency.port';
import { ExportApplyCommand } from './application/commands/export-apply.command';
import { ExportRetryCommand } from './application/commands/export-retry.command';
import { ExportDeleteCommand } from './application/commands/export-delete.command';
import { InMemoryExportTaskRepository } from './infrastructure/in-memory-export-repository';
import { InMemoryExportFactSource } from './infrastructure/in-memory-export-fact-source';
import { InMemoryExportIdempotency } from './infrastructure/in-memory-export-idempotency';
import {
  InMemoryExportAuditPort,
  MemoryExportAuthorizationPort,
  MemoryExportReauthPort,
  MemoryExportSafetySwitchPort,
} from './infrastructure/memory-export-access';
import { InMemoryExportDownloadFilePort } from './infrastructure/in-memory-export-download';
import { ExportController } from './interfaces/http/export.controller';
// ---------------------------------------------------------------------------
// 5.4.4 异步生成、有效期与下载审计（EXP-001/EXP-002/EXP-003）
// ---------------------------------------------------------------------------
import { EXPORT_DATASET_SOURCE } from './application/ports/export-dataset-source.port';
import { EXPORT_FILE_RENDERER_PORT } from './application/ports/export-file-renderer.port';
import { EXPORT_FILE_WRITER_PORT } from './application/ports/export-file-writer.port';
import { EXPORT_DISPOSAL_PORT } from './application/ports/export-disposal.port';
import { EXPORT_NOTIFICATION_PORT } from './application/ports/export-notification.port';
import { EXPORT_RETENTION_CONFIG_PORT } from './application/ports/export-retention-config.port';
import { InMemoryExportDatasetSource } from './infrastructure/in-memory-export-dataset-source';
import { XlsxExportFileRenderer } from './infrastructure/export-file/xlsx-export-file-renderer';
import { InMemoryExportFileStore } from './infrastructure/in-memory-export-file-store';
import { InMemoryExportNotification } from './infrastructure/in-memory-export-notification';
import { MemoryExportRetentionConfig } from './infrastructure/memory-export-retention-config';
import { ExportGenerationCommand } from './application/commands/export-generation.command';
import { ExportExpirySweepCommand } from './application/commands/export-expiry-sweep.command';

// Token for the specification — used by export module (5.4.2~5.4.4) via DI
export const STATISTICS_SPECIFICATION = Symbol('STATISTICS_SPECIFICATION');

/**
 * 生产环境 fail-closed 统计授权桩。
 *
 * MemoryStatisticsAuthorizationPort（GOV-007 生产即 throw）会在生产 DI 解析时崩溃；
 * 此桩不抛错，所有用户解析为空作用域、非平台超管，统计请求被拒（fail-closed）。
 */
class ProductionFailClosedStatisticsAuthorization implements StatisticsAuthorizationPort {
  async resolvePrincipal(userId: string): Promise<StatisticsPrincipal> {
    return { userId, isPlatformSuperAdmin: false, clubScopes: [] };
  }
}

/**
 * 生产环境 fail-closed 导出授权桩。
 *
 * 对象存储/真实身份授权未接入前，StatExportModule 已被 app.module.ts 无条件导入；
 * 若沿用 MemoryExportAuthorizationPort（GOV-007 生产即 throw）会在生产 DI 解析时
 * 直接崩溃整个应用。此桩不抛错，但所有用户解析为空作用域的普通成员，
 * 使一切导出请求被拒（fail-closed），待真实实现替换后再放权。
 */
class ProductionFailClosedExportAuthorization implements ExportAuthorizationPort {
  async resolveExportPrincipal(userId: string): Promise<ExportPrincipal> {
    return { userId, kind: 'member_applicant', clubScopes: [] };
  }
}

@Module({
  controllers: [StatisticsController, ExportController],
  providers: [
    // 领域规则（纯规则 singleton）
    StatisticsSpecification,
    { provide: STATISTICS_SPECIFICATION, useExisting: StatisticsSpecification },

    // 基础设施端口（内存桩，后续替换为 PostgreSQL 实现）
    { provide: STATISTICS_SOURCE, useClass: InMemoryStatisticsSource },
    {
      provide: STATISTICS_AUTHORIZATION_PORT,
      // 授权桩种子：默认空种子（fail-closed）。dev/test 联调演示可设
      // ORG_DEV_STATS_DEMO=1 + ORG_DEV_STATS_DEMO_CLUBS/… 提供明确演示主体，
      // 见 buildMemoryStatisticsAuthorizationSeedFromEnv 注释。不设时所有用户解析为
      // 空作用域，统计端点返回 403——属有意为空的过渡态，避免误放权。
      // 生产用 fail-closed 空作用域桩，避免 GOV-007 使整个应用无法启动。
      useFactory: () =>
        process.env['NODE_ENV'] === 'production'
          ? new ProductionFailClosedStatisticsAuthorization()
          : new MemoryStatisticsAuthorizationPort(buildMemoryStatisticsAuthorizationSeedFromEnv()),
    },
    { provide: STATISTICS_AUDIT_PORT, useClass: InMemoryStatisticsAuditPort },

    // 应用查询用例
    ClubStatisticsQuery,
    RecruitmentFunnelQuery,
    JointActivityStatisticsQuery,

    // -------------------------------------------------------------------
    // 5.4.2 导出：端口（内存桩，后续替换为 PostgreSQL / 对象存储实现）
    // -------------------------------------------------------------------
    // 授权桩按环境装配：dev/test 用内存演示桩；生产用 fail-closed 空作用域桩
    // （不抛错、不装配开发门禁，避免 GOV-007 使整个应用无法启动），
    // 空作用域导致所有导出解析为无权限主体，生产在真实授权实现落地前保持不可导出。
    {
      provide: EXPORT_AUTHORIZATION_PORT,
      useFactory: () =>
        process.env['NODE_ENV'] === 'production'
          ? new ProductionFailClosedExportAuthorization()
          : new MemoryExportAuthorizationPort({}),
    },
    { provide: EXPORT_SAFETY_SWITCH_PORT, useClass: MemoryExportSafetySwitchPort },
    { provide: EXPORT_REAUTH_PORT, useClass: MemoryExportReauthPort },
    { provide: EXPORT_AUDIT_PORT, useClass: InMemoryExportAuditPort },
    { provide: EXPORT_TASK_REPOSITORY, useClass: InMemoryExportTaskRepository },
    { provide: EXPORT_FACT_SOURCE, useClass: InMemoryExportFactSource },
    { provide: EXPORT_DOWNLOAD_FILE_PORT, useClass: InMemoryExportDownloadFilePort },
    { provide: EXPORT_APPLY_IDEMPOTENCY, useClass: InMemoryExportIdempotency },

    // -------------------------------------------------------------------
    // 5.4.4 异步生成管线：端口（内存桩，后续替换为对象存储 / config / 通知实现）
    // -------------------------------------------------------------------
    { provide: EXPORT_DATASET_SOURCE, useClass: InMemoryExportDatasetSource },
    { provide: EXPORT_FILE_RENDERER_PORT, useClass: XlsxExportFileRenderer },
    // 写出与处置绑定同一实例（dispose 必须能删除 write 写入的文件）
    InMemoryExportFileStore,
    { provide: EXPORT_FILE_WRITER_PORT, useExisting: InMemoryExportFileStore },
    { provide: EXPORT_DISPOSAL_PORT, useExisting: InMemoryExportFileStore },
    { provide: EXPORT_NOTIFICATION_PORT, useClass: InMemoryExportNotification },
    { provide: EXPORT_RETENTION_CONFIG_PORT, useClass: MemoryExportRetentionConfig },

    // 5.4.2 导出命令
    ExportApplyCommand,
    ExportRetryCommand,
    ExportDeleteCommand,

    // 5.4.4 导出命令（生成由 platform/tasks worker 驱动；过期扫描由运维轮询触发）
    ExportGenerationCommand,
    ExportExpirySweepCommand,
  ],
  exports: [
    // 导出模块（5.4.2~5.4.4）与统计共享口径基线
    STATISTICS_SPECIFICATION,
    STATISTICS_SOURCE,
    // 查询用例供其他模块或 worker 调用
    ClubStatisticsQuery,
    RecruitmentFunnelQuery,
    JointActivityStatisticsQuery,
    // 5.4.4：生成/过期命令与端口令牌导出，供 TasksModule 与生产适配器替换装配
    ExportGenerationCommand,
    ExportExpirySweepCommand,
    EXPORT_DATASET_SOURCE,
    EXPORT_FILE_RENDERER_PORT,
    EXPORT_FILE_WRITER_PORT,
    EXPORT_DISPOSAL_PORT,
    EXPORT_NOTIFICATION_PORT,
    EXPORT_RETENTION_CONFIG_PORT,
  ],
})
export class StatExportModule {}
