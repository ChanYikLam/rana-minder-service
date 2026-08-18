/**
 * 平台支撑 · 运维与可观测性 —— 纯领域规则集合。
 *
 * 本文件仅作为 domain 层的导出入口；不引入 NestJS DI、不做 I/O、不读环境变量。
 * 后续由 infrastructure/LogWriterAdapter、TraceContextAdapter 消费本规则。
 *
 * 路径：src/platform/observability/domain/services/（PR #32 §2.2 B；2026-08-18 由
 * src/modules/ops/domain/services/ 整体迁移）。
 */

export {
  FORBIDDEN_KEY_PATTERNS,
  SENSITIVE_KEY_PATTERNS,
  PATH_KEY_PATTERNS,
  SAFE_KEY_PATTERNS,
  DEFAULT_TRUNCATE_MAX,
  PATH_SEGMENT_KEEP_FIRST,
  decide,
  redactValue,
  redactRecord,
  type RedactionDecision,
} from './redaction.rules';

export {
  DEFAULT_RETENTION_POLICIES,
  resolveRetention,
  isLogTier,
  type LogTier,
  type RetentionPolicy,
} from './retention.rules';

export {
  TRACE_PREFIX,
  generateTraceId,
  isTraceId,
  deriveTrace,
  type TraceDerivation,
} from './trace-id.generator';
