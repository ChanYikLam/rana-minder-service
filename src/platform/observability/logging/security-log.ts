/**
 * 网络/安全事件日志写入器（ADR-011 §2.1：≥6 个月保留）。
 *
 * 路径：src/platform/observability/logging/（PR #32 §2.2 B）。
 *
 * 与 app-logger 同形态，tier 语义不同：调用方约定传 tier='network' 或
 * tier='security'，由 RetentionExecutor 在 7️⃣ 阶段按 RetentionRules 派生
 * 归档策略。本类只负责"写入前脱敏 + 序列化 + 调用 Logger"。
 *
 * 不做的事：见 app-logger.ts 头部说明。
 */

import { Logger } from '@nestjs/common';

import { type LogRecord, type LogSanitizer, DefaultLogSanitizer } from './sanitizer';

export interface SecurityLogger {
  warn(record: LogRecord): void;
  error(record: LogRecord): void;
}

export interface NestSecurityLoggerOptions {
  readonly contextName?: string;
  readonly sanitizer?: LogSanitizer;
  readonly maxFieldLength?: number;
}

export class NestSecurityLogger implements SecurityLogger {
  private readonly logger: Logger;
  private readonly sanitizer: LogSanitizer;
  private readonly maxFieldLength?: number;

  constructor(options: NestSecurityLoggerOptions = {}) {
    this.logger = new Logger(options.contextName ?? 'Security');
    this.sanitizer = options.sanitizer ?? new DefaultLogSanitizer();
    this.maxFieldLength = options.maxFieldLength;
  }

  warn(record: LogRecord): void {
    this.logger.warn(this.serialize(record));
  }

  error(record: LogRecord): void {
    this.logger.error(this.serialize(record));
  }

  private serialize(record: LogRecord): string {
    const sanitized = this.sanitizer.sanitize(record, {
      ...(this.maxFieldLength !== undefined ? { maxFieldLength: this.maxFieldLength } : {}),
    });
    return JSON.stringify(sanitized);
  }
}
