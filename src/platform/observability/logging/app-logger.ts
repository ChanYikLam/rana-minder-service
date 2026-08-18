/**
 * 普通运行日志写入器（ADR-011 §2.1：30 天在线 + 60 天压缩归档）。
 *
 * 路径：src/platform/observability/logging/（PR #32 §2.2 B）。
 *
 * 不做的事（与本模块边界一致）：
 * - 不替代业务审计（AUD-*；独立长期保留），不投递系统外告警（XCC-GEN-007）；
 * - 不读取/写入业务数据；不引入 HTTP/DB 依赖；
 * - 不在本类内做"摘要输出"——结构化 JSON 由消费端（ELK/Loki/DevOps 平台）
 *   解析。
 *
 * 当前实现：
 * - 走 NestJS Logger（@nestjs/common），输出 JSON 字符串；首版不替换控制台
 *   行为，便于开发期直接 `pnpm start:dev` 调试；
 * - 实际归档/清理由 infrastructure/LogWriterAdapter 在 7️⃣ 阶段接入；本类只
 *   负责"写入前脱敏 + 序列化 + 调用 Logger"。
 */

import { Logger } from '@nestjs/common';

import { type LogRecord, type LogSanitizer, DefaultLogSanitizer } from './sanitizer';

export type LogLevel = 'info' | 'warn' | 'error';

export interface AppLogger {
  info(record: LogRecord): void;
  warn(record: LogRecord): void;
  error(record: LogRecord): void;
}

export interface NestAppLoggerOptions {
  readonly contextName?: string;
  readonly sanitizer?: LogSanitizer;
  readonly maxFieldLength?: number;
}

export class NestAppLogger implements AppLogger {
  private readonly logger: Logger;
  private readonly sanitizer: LogSanitizer;
  private readonly maxFieldLength?: number;

  constructor(options: NestAppLoggerOptions = {}) {
    this.logger = new Logger(options.contextName ?? 'App');
    this.sanitizer = options.sanitizer ?? new DefaultLogSanitizer();
    this.maxFieldLength = options.maxFieldLength;
  }

  info(record: LogRecord): void {
    this.logger.log(this.serialize(record));
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
