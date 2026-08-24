/**
 * 结构化日志字段脱敏器——把 redaction 规则应用到实际日志写入流程。
 *
 * 覆盖：observability/README §6.1、AUD-013、AUD-014。
 *
 * 本类只做"结构化字段过滤"：key 名命中 FORBIDDEN_KEY_PATTERNS → 整字段丢弃；
 * 命中 SENSITIVE_KEY_PATTERNS → mask；命中 SAFE_KEY_PATTERNS → 原样保留；
 * 其余按 truncate(200) 处理。底层策略由 domain/services/redaction.rules 提供。
 *
 * 不做：
 * - 业务审计（AUD-*）——边界由 audit-link/audit-boundary 守卫；
 * - 写外部存储/网络——由 infrastructure/LogWriterAdapter（7️⃣ 阶段）承接；
 * - 跟踪/关联——由 tracing/* 承接。
 *
 * 路径：src/platform/observability/logging/（PR #32 §2.2 B）。
 */

import { redactRecord } from '../domain/services/redaction.rules';

export type LogRecord = Record<string, unknown>;

export interface SanitizeOptions {
  // 自定义单字段最大字符数（默认沿用 RedactionRules.DEFAULT_TRUNCATE_MAX=200）。
  readonly maxFieldLength?: number;
  // 强制 omit 的字段名（即使 redaction 规则允许）。用于业务方按上下文进一步
  // 收紧：例如某命令在报错的当下，禁止带 args.* 进入运行日志。
  readonly extraOmitKeys?: readonly string[];
}

export interface LogSanitizer {
  sanitize(input: LogRecord, options?: SanitizeOptions): LogRecord;
}

export class DefaultLogSanitizer implements LogSanitizer {
  sanitize(input: LogRecord, options: SanitizeOptions = {}): LogRecord {
    const redacted = redactRecord(input);

    if (options.extraOmitKeys !== undefined) {
      for (const k of options.extraOmitKeys) {
        delete redacted[k];
      }
    }

    if (options.maxFieldLength !== undefined) {
      const max = options.maxFieldLength;
      for (const [k, v] of Object.entries(redacted)) {
        if (typeof v === 'string' && v.length > max) {
          redacted[k] = `${v.slice(0, max)}...[truncated]`;
        }
      }
    }

    return redacted;
  }
}
