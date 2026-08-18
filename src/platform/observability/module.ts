/**
 * 平台支撑 · 运维与可观测性模块入口（ADR-002 §2.2 + ADR-011 + PR #32 §2.2 B）。
 *
 * 当前阶段已注册：
 * - domain/services：redaction.rules / retention.rules / trace-id.generator（纯规则）
 * - logging：sanitizer / app-logger / security-log / retention-executor
 * - tracing：trace-id-factory / span-link / correlation / trace-context adapter
 * - audit-link：audit-boundary assert
 *
 * 后续接入顺序（不在本 MR 范围，按 PR #32 §2.2 B 子任务次序）：
 *   status-page/ → health-summary/ → backup-report/
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

import { Module, type Provider } from '@nestjs/common';

import {
  REDACTION_RULES,
  RETENTION_RULES,
  TRACE_ID_GENERATOR,
} from './domain/services/tokens';
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
} from './logging/tokens';
import { DefaultLogSanitizer } from './logging/sanitizer';
import { NestAppLogger } from './logging/app-logger';
import { NestSecurityLogger } from './logging/security-log';
import { DefaultRetentionExecutor } from './logging/retention';

import {
  SPAN_LINK,
  CORRELATION,
  TRACE_CONTEXT,
} from './tracing/tokens';
import { DefaultSpanLinkFactory } from './tracing/span-link';
import { DefaultCorrelation } from './tracing/correlation';
import {
  createTraceContextAdapter,
  type TraceContextAdapter,
} from './infrastructure/trace-context.adapter';

import { AUDIT_BOUNDARY_ASSERT } from './audit-link/tokens';
import { DefaultAuditBoundaryAssert } from './audit-link/audit-boundary';

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

@Module({
  imports: [],
  providers: [
    REDACTION_RULES_PROVIDER,
    RETENTION_RULES_PROVIDER,
    TRACE_ID_PROVIDER,
    LOG_SANITIZER_PROVIDER,
    APP_LOGGER_PROVIDER,
    SECURITY_LOGGER_PROVIDER,
    RETENTION_EXECUTOR_PROVIDER,
    SPAN_LINK_PROVIDER,
    CORRELATION_PROVIDER,
    TRACE_CONTEXT_PROVIDER,
    AUDIT_BOUNDARY_ASSERT_PROVIDER,
  ],
  exports: [
    REDACTION_RULES,
    RETENTION_RULES,
    TRACE_ID_GENERATOR,
    LOG_SANITIZER,
    APP_LOGGER,
    SECURITY_LOGGER,
    RETENTION_EXECUTOR,
    SPAN_LINK,
    CORRELATION,
    TRACE_CONTEXT,
    AUDIT_BOUNDARY_ASSERT,
  ],
})
export class ObservabilityModule {}