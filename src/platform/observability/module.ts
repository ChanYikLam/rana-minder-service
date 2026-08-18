/**
 * 平台支撑 · 运维与可观测性模块入口（ADR-002 §2.2 + ADR-011 + PR #32 §2.2 B）。
 *
 * 当前阶段已注册：
 * - domain/services：redaction.rules / retention.rules / trace-id.generator（纯规则）
 * - logging：sanitizer / app-logger / security-log / retention-executor
 * - tracing：trace-id-factory / span-link / correlation / trace-context adapter
 * - audit-link：audit-boundary assert
 * - status-page：stale-unknown rule + 5 个端口（app/db/task/dep/authorizer）+ 状态汇总
 *   查询用例 + Controller（仅超管、只读、过期即未知；DB/任务/适配器端口当前为
 *   "未连接"桩实现，返回 'unknown' 以满足 ADR-011 §2.1 第 2 条）
 * - health-summary：基于 StatusSummaryQueryService 的对内子系统健康汇总判定
 *   （不是机器健康端点；不对外暴露 HTTP）
 * - backup-report：备份/恢复最近事件只读视图（不替代备份系统、不成为完成证明）
 *
 * 后续接入顺序（不在本 MR 范围，按 PR #32 §2.2 B 子任务次序）：
 *   health-summary/ → backup-report/
 *   → 基础设施 & 应用层组装（LogWriterAdapter / StatusSummaryRepository /
 *     StatusSummaryQueryService / LogQueryUseCase）→ 测试。
 *
 * 边界（ADR-011 §2.1 核心不变量；本模块第一阶段即锁定，约束后续所有子模块）：
 *
 * 1. 状态页读取技术运行事实或可重建摘要，**不成为**业务状态、权限、通知事实、
 *    任务执行权威或备份完成证明。
 * 2. 状态来源过期时必须显示"未知"，不得以最近一次成功伪装当前健康。
 * 3. 观测信息不得自动改变录取、邀请、成员、部门、职位、评价、权限或其他业务
 *    结论。
 * 4. 业务审计独立长期保留，运行日志不得替代业务审计；业务幂等键与追踪编号
 *    不得混同（XCC-GEN-001）。
 *
 * 依赖注入：使用 useValue / useFactory 把纯函数与适配器冻结为 provider 对象；
 * 规则保持 `Object.freeze` 不可变，便于在测试中辨别误改。
 */

import { Module, MiddlewareConsumer, NestModule, type Provider } from '@nestjs/common';

import { REDACTION_RULES, RETENTION_RULES, TRACE_ID_GENERATOR } from './domain/services/tokens';
import {
  FORBIDDEN_KEY_PATTERNS,
  SENSITIVE_KEY_PATTERNS,
  PATH_KEY_PATTERNS,
  SAFE_KEY_PATTERNS,
  DEFAULT_TRUNCATE_MAX,
  decide,
  redactValue,
  redactRecord,
} from './domain/services/redaction.rules';
import {
  DEFAULT_RETENTION_POLICIES,
  resolveRetention,
  isLogTier,
} from './domain/services/retention.rules';
import {
  TRACE_PREFIX,
  generateTraceId,
  isTraceId,
  deriveTrace,
} from './domain/services/trace-id.generator';

import {
  LOG_SANITIZER,
  APP_LOGGER,
  SECURITY_LOGGER,
  RETENTION_EXECUTOR,
  LOG_STORAGE,
  LOG_WRITER,
  LOG_QUERY,
  NEST_LOGGER_SERVICE,
} from './logging/tokens';
import { DefaultLogSanitizer } from './logging/sanitizer';
import { NestAppLogger } from './logging/app-logger';
import { NestSecurityLogger } from './logging/security-log';
import { DefaultRetentionExecutor } from './logging/retention';
import { DefaultLogQueryUseCase } from './logging/log-query.use-case';

import { SPAN_LINK, CORRELATION, TRACE_CONTEXT } from './tracing/tokens';
import { DefaultSpanLinkFactory } from './tracing/span-link';
import { DefaultCorrelation } from './tracing/correlation';
import {
  createTraceContextAdapter,
  type TraceContextAdapter,
} from './infrastructure/trace-context.adapter';
import { NotWiredLogStoragePort } from './infrastructure/log-storage.port';
import { DefaultLogWriterAdapter } from './infrastructure/log-writer.adapter';
import { NestLoggerServiceAdapter } from './infrastructure/nest-logger.adapter';

import { AUDIT_BOUNDARY_ASSERT } from './audit-link/tokens';
import { DefaultAuditBoundaryAssert } from './audit-link/audit-boundary';

import {
  STALE_UNKNOWN_RULE,
  APP_STATUS_PORT,
  DB_STATUS_PORT,
  TASK_SUMMARY_PORT,
  DEP_LATEST_PORT,
  STATUS_PAGE_AUTHORIZER,
  STATUS_SUMMARY_QUERY,
} from './status-page/tokens';
import { DefaultStaleUnknownRule } from './status-page/stale-unknown';
import { ProcessAppStatusPort } from './status-page/app-status';
import { NotWiredDbStatusPort } from './status-page/db-status';
import { NotWiredTaskSummaryPort } from './status-page/task-summary';
import { NotWiredDepLatestPort } from './status-page/dep-latest';
import { RejectAllStatusPageAuthorizer } from './status-page/status-page-authorizer';
import { DefaultStatusSummaryQueryService } from './status-page/status-summary-query.service';
import { StatusPageController } from './status-page/page-controller';

import { TraceMiddleware } from './interfaces/trace.middleware';

import { HEALTH_SUMMARY_SERVICE } from './health-summary/tokens';
import { DefaultHealthSummaryService } from './health-summary/health-summary';

import { BACKUP_REPORT_PORT, BACKUP_REPORT_SERVICE } from './backup-report/tokens';
import {
  DefaultBackupReportService,
  NotWiredBackupReportPort,
} from './backup-report/backup-report';

// ----- domain/services providers -----

const REDACTION_RULES_PROVIDER: Provider = {
  provide: REDACTION_RULES,
  useValue: Object.freeze({
    FORBIDDEN_KEY_PATTERNS,
    SENSITIVE_KEY_PATTERNS,
    PATH_KEY_PATTERNS,
    SAFE_KEY_PATTERNS,
    DEFAULT_TRUNCATE_MAX,
    decide,
    redactValue,
    redactRecord,
  }),
};

const RETENTION_RULES_PROVIDER: Provider = {
  provide: RETENTION_RULES,
  useValue: Object.freeze({
    DEFAULT_RETENTION_POLICIES,
    resolveRetention,
    isLogTier,
  }),
};

const TRACE_ID_PROVIDER: Provider = {
  provide: TRACE_ID_GENERATOR,
  useValue: Object.freeze({
    TRACE_PREFIX,
    generateTraceId,
    isTraceId,
    deriveTrace,
  }),
};

// ----- logging providers -----

const LOG_SANITIZER_PROVIDER: Provider = {
  provide: LOG_SANITIZER,
  useValue: Object.freeze({
    sanitize: (input: Record<string, unknown>, options?: Record<string, unknown>) =>
      new DefaultLogSanitizer().sanitize(input, options as never),
  }),
};

const APP_LOGGER_PROVIDER: Provider = {
  provide: APP_LOGGER,
  useFactory: () => new NestAppLogger(),
};

const SECURITY_LOGGER_PROVIDER: Provider = {
  provide: SECURITY_LOGGER,
  useFactory: () => new NestSecurityLogger(),
};

const RETENTION_EXECUTOR_PROVIDER: Provider = {
  provide: RETENTION_EXECUTOR,
  useFactory: () => new DefaultRetentionExecutor(),
};

const LOG_STORAGE_PROVIDER: Provider = {
  provide: LOG_STORAGE,
  useFactory: () => new NotWiredLogStoragePort(),
};

const LOG_WRITER_PROVIDER: Provider = {
  provide: LOG_WRITER,
  useFactory: (sanitizer, auditBoundary, appLogger, securityLogger, storage) =>
    new DefaultLogWriterAdapter(sanitizer, auditBoundary, appLogger, securityLogger, storage),
  inject: [LOG_SANITIZER, AUDIT_BOUNDARY_ASSERT, APP_LOGGER, SECURITY_LOGGER, LOG_STORAGE],
};

const LOG_QUERY_PROVIDER: Provider = {
  provide: LOG_QUERY,
  useFactory: (storage, sanitizer) => new DefaultLogQueryUseCase(storage, sanitizer),
  inject: [LOG_STORAGE, LOG_SANITIZER],
};

const NEST_LOGGER_SERVICE_PROVIDER: Provider = {
  provide: NEST_LOGGER_SERVICE,
  useFactory: (sanitizer, appLogger) => new NestLoggerServiceAdapter({ sanitizer, appLogger }),
  inject: [LOG_SANITIZER, APP_LOGGER],
};

// ----- tracing providers -----

const SPAN_LINK_PROVIDER: Provider = {
  provide: SPAN_LINK,
  useValue: Object.freeze({
    factory: new DefaultSpanLinkFactory(),
  }),
};

const CORRELATION_PROVIDER: Provider = {
  provide: CORRELATION,
  useFactory: () => new DefaultCorrelation(),
};

const TRACE_CONTEXT_PROVIDER: Provider = {
  provide: TRACE_CONTEXT,
  useFactory: (): TraceContextAdapter => createTraceContextAdapter(),
};

// ----- audit-link providers -----

const AUDIT_BOUNDARY_ASSERT_PROVIDER: Provider = {
  provide: AUDIT_BOUNDARY_ASSERT,
  useFactory: () => new DefaultAuditBoundaryAssert(),
};

// ----- status-page providers -----

const STALE_UNKNOWN_RULE_PROVIDER: Provider = {
  provide: STALE_UNKNOWN_RULE,
  useFactory: () => new DefaultStaleUnknownRule(),
};

const APP_STATUS_PORT_PROVIDER: Provider = {
  provide: APP_STATUS_PORT,
  // 首版 version 来源兜底；1.5 配置骨架完善后由 RanaMinderConfig 注入真实 version
  // + 启动时间戳。
  useFactory: () =>
    new ProcessAppStatusPort(process.env['npm_package_version'] ?? '0.0.0', new Date()),
};

const DB_STATUS_PORT_PROVIDER: Provider = {
  provide: DB_STATUS_PORT,
  useFactory: () => new NotWiredDbStatusPort(),
};

const TASK_SUMMARY_PORT_PROVIDER: Provider = {
  provide: TASK_SUMMARY_PORT,
  useFactory: () => new NotWiredTaskSummaryPort(),
};

const DEP_LATEST_PORT_PROVIDER: Provider = {
  provide: DEP_LATEST_PORT,
  useFactory: () => new NotWiredDepLatestPort(),
};

const STATUS_PAGE_AUTHORIZER_PROVIDER: Provider = {
  provide: STATUS_PAGE_AUTHORIZER,
  // fail-closed：身份模块接入前一律拒绝；接入后由 useClass 替换为身份判定实现。
  useFactory: () => new RejectAllStatusPageAuthorizer(),
};

const STATUS_SUMMARY_QUERY_PROVIDER: Provider = {
  provide: STATUS_SUMMARY_QUERY,
  useFactory: (app, db, task, dep) => new DefaultStatusSummaryQueryService(app, db, task, dep),
  inject: [APP_STATUS_PORT, DB_STATUS_PORT, TASK_SUMMARY_PORT, DEP_LATEST_PORT],
};

// ----- health-summary providers -----

const HEALTH_SUMMARY_SERVICE_PROVIDER: Provider = {
  provide: HEALTH_SUMMARY_SERVICE,
  useFactory: (query) => new DefaultHealthSummaryService(query),
  inject: [STATUS_SUMMARY_QUERY],
};

// ----- backup-report providers -----

const BACKUP_REPORT_PORT_PROVIDER: Provider = {
  provide: BACKUP_REPORT_PORT,
  useFactory: () => new NotWiredBackupReportPort(),
};

const BACKUP_REPORT_SERVICE_PROVIDER: Provider = {
  provide: BACKUP_REPORT_SERVICE,
  useFactory: (port) => new DefaultBackupReportService(port),
  inject: [BACKUP_REPORT_PORT],
};

@Module({
  imports: [],
  controllers: [StatusPageController],
  providers: [
    REDACTION_RULES_PROVIDER,
    RETENTION_RULES_PROVIDER,
    TRACE_ID_PROVIDER,
    LOG_SANITIZER_PROVIDER,
    APP_LOGGER_PROVIDER,
    SECURITY_LOGGER_PROVIDER,
    RETENTION_EXECUTOR_PROVIDER,
    LOG_STORAGE_PROVIDER,
    LOG_WRITER_PROVIDER,
    LOG_QUERY_PROVIDER,
    NEST_LOGGER_SERVICE_PROVIDER,
    SPAN_LINK_PROVIDER,
    CORRELATION_PROVIDER,
    TRACE_CONTEXT_PROVIDER,
    AUDIT_BOUNDARY_ASSERT_PROVIDER,
    STALE_UNKNOWN_RULE_PROVIDER,
    APP_STATUS_PORT_PROVIDER,
    DB_STATUS_PORT_PROVIDER,
    TASK_SUMMARY_PORT_PROVIDER,
    DEP_LATEST_PORT_PROVIDER,
    STATUS_PAGE_AUTHORIZER_PROVIDER,
    STATUS_SUMMARY_QUERY_PROVIDER,
    HEALTH_SUMMARY_SERVICE_PROVIDER,
    BACKUP_REPORT_PORT_PROVIDER,
    BACKUP_REPORT_SERVICE_PROVIDER,
  ],
  exports: [
    REDACTION_RULES,
    RETENTION_RULES,
    TRACE_ID_GENERATOR,
    LOG_SANITIZER,
    APP_LOGGER,
    SECURITY_LOGGER,
    RETENTION_EXECUTOR,
    LOG_STORAGE,
    LOG_WRITER,
    LOG_QUERY,
    NEST_LOGGER_SERVICE,
    SPAN_LINK,
    CORRELATION,
    TRACE_CONTEXT,
    AUDIT_BOUNDARY_ASSERT,
    STALE_UNKNOWN_RULE,
    APP_STATUS_PORT,
    DB_STATUS_PORT,
    TASK_SUMMARY_PORT,
    DEP_LATEST_PORT,
    STATUS_PAGE_AUTHORIZER,
    STATUS_SUMMARY_QUERY,
    HEALTH_SUMMARY_SERVICE,
    BACKUP_REPORT_PORT,
    BACKUP_REPORT_SERVICE,
  ],
})
export class ObservabilityModule implements NestModule {
  // 全局挂 TraceMiddleware：让每一次 HTTP 请求都进入 AsyncLocalStorage 上下文，
  // 业务代码 / 拦截器 / 守卫 / 管道都可通过 TraceContextAdapter.current() 取到 traceId。
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
