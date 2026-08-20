/**
 * 脱敏日志写入适配器（ADR-011 §2.1、observability/README §6.1）。
 *
 * 统一入口：所有运行日志经过本适配器写入，先执行字段允许清单与脱敏规则，
 * 再交给 NestJS Logger 输出；调用方不得绕过本适配器直接打印敏感上下文。
 */
import { Inject, Injectable, Logger } from '@nestjs/common';

import { REDACTION_RULES } from '../domain/services/tokens';
import type { TraceContextAdapter } from './trace-context.adapter';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RedactionRules {
  readonly redactRecord: (input: Record<string, unknown>) => Record<string, unknown>;
}

@Injectable()
export class LogWriterAdapter {
  private readonly logger = new Logger('Observability');

  constructor(
    private readonly traceContext: TraceContextAdapter,
    @Inject(REDACTION_RULES) private readonly redactionRules: RedactionRules,
  ) {}

  debug(message: string, context?: Record<string, unknown>): void {
    this.write('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.write('error', message, context);
  }

  private write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const safeContext = this.redactionRules.redactRecord(context ?? {});
    const traceId = this.traceContext.getTraceId();
    const payload = {
      ...safeContext,
      ...(traceId ? { traceId } : {}),
    };
    const output = Object.keys(payload).length > 0 ? payload : undefined;

    switch (level) {
      case 'debug':
        this.logger.debug(output ? `${message} ${JSON.stringify(output)}` : message);
        break;
      case 'info':
        this.logger.log(output ? `${message} ${JSON.stringify(output)}` : message);
        break;
      case 'warn':
        this.logger.warn(output ? `${message} ${JSON.stringify(output)}` : message);
        break;
      case 'error':
        this.logger.error(output ? `${message} ${JSON.stringify(output)}` : message);
        break;
    }
  }
}
