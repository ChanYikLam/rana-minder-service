/**
 * 日志写入适配——统一执行 audit-boundary 守卫 + 脱敏 + 落存储 + 镜像 stdout。
 *
 * 路径：src/platform/observability/infrastructure/（PR #32 §2.2 B）。
 *
 * 落地步骤（按顺序；任一失败即短路或降级）：
 * 1. **audit-boundary 守卫**：所有顶层 key 必须不在 audit./permission./role./
 *    authorization./decision. 前缀（详见 audit-link/audit-boundary）。命中即
 *    抛 AuditBoundaryViolation——整条记录拒绝写入（fail-closed）。
 * 2. **sanitize**：通过 LogSanitizer 应用 RedactionRules（详见 logging/sanitizer）。
 * 3. **写存储**：调 LogStoragePort.write()；失败**不抛**——避免日志写入反向
 *    影响业务路径（ADR-011 §6.3：观测信息不得自动改变业务结论）。
 * 4. **镜像 stdout**：调 NestAppLogger / NestSecurityLogger，便于本地 dev
 *    直接 `pnpm start:dev` 查看结构化 JSON。
 *
 * 不做的事：业务审计（AUD-*）由 audit 模块独立写，**不**通过本适配器；不
 * 投递系统外告警（XCC-GEN-007）；不调用任何写命令。
 */

import { type AuditBoundaryAssert, AuditBoundaryViolation } from '../audit-link/audit-boundary';
import { type AppLogger, type LogLevel } from '../logging/app-logger';
import { type LogRecord, type LogSanitizer } from '../logging/sanitizer';
import { type SecurityLogger } from '../logging/security-log';
import type { LogTier } from '../domain/services/retention.rules';
import { isTraceId } from '../domain/services/trace-id.generator';
import { type LogStoragePort } from './log-storage.port';

export interface LogWriterAdapter {
  write(tier: LogTier, record: LogRecord): Promise<void>;
}

export class DefaultLogWriterAdapter implements LogWriterAdapter {
  constructor(
    private readonly sanitizer: LogSanitizer,
    private readonly auditBoundary: AuditBoundaryAssert,
    private readonly appLogger: AppLogger,
    private readonly securityLogger: SecurityLogger,
    private readonly storage: LogStoragePort,
  ) {}

  async write(tier: LogTier, record: LogRecord): Promise<void> {
    // 1) audit-boundary 守卫：fail-closed。
    for (const key of Object.keys(record)) {
      this.auditBoundary.assert(key);
    }

    // 2) sanitize。
    const sanitized = this.sanitizer.sanitize(record, {
      // traceId 字段允许原样保留——但若调用方误把 traceId 之外的内容塞到
      // _trace* 字段，安全规则由 RedactionRules.SAFE_KEY_PATTERNS 兜底。
      extraOmitKeys: collectForbiddenTraceFields(record),
    });

    // 3) 落存储（失败吞掉）。
    try {
      await this.storage.write(tier, record, sanitized);
    } catch {
      // 静默降级：日志写入不得影响业务路径。
    }

    // 4) 镜像 stdout。
    const enriched: LogRecord = { ...sanitized, tier };
    this.mirror(tier, enriched);
  }

  private mirror(tier: LogTier, record: LogRecord): void {
    const level: LogLevel = tier === 'security' || tier === 'network' ? 'warn' : 'info';
    if (tier === 'normal') {
      this.appLogger[level === 'info' ? 'info' : 'warn'](record);
    } else {
      this.securityLogger.warn(record);
    }
  }
}

// 调用方偶尔会把"非追踪编号"的字段错放进 _trace*；本函数把不在 SAFE 列表
// 的"假 trace"字段追加为 omit，避免重写规则。
function collectForbiddenTraceFields(record: LogRecord): readonly string[] {
  const traceIdKeys = Object.keys(record).filter((k) => /^_?trace(Id|ParentId)?$/i.test(k));
  const forbidden: string[] = [];
  for (const k of traceIdKeys) {
    const v = record[k];
    if (typeof v !== 'string' || !isTraceId(v)) {
      forbidden.push(k);
    }
  }
  return forbidden;
}

// 重新导出，便于 module.ts 与 controller 引用。
export { AuditBoundaryViolation };