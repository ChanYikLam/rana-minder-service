/**
 * 平台支撑 · 运维与可观测性 —— 纯领域规则集合。
 *
 * 本文件仅作为 domain 层的导出入口；不引入 NestJS DI、不做 I/O、不读环境变量。
 * 后续由 infrastructure/LogWriterAdapter、TraceContextAdapter 消费本规则。
 *
 * 路径迁移：本目录位于 src/modules/ops/domain/services/，与 ops/README.md §5
 * 一致；如 PR #32 落地，需整体迁移至 src/platform/observability/domain/services/。
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