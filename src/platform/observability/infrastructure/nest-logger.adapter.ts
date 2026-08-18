/**
 * NestJS LoggerService 适配——把 NestJS 内部日志（路由注册、模块初始化、
 * 启动横幅等）接到 observability 的脱敏管道。
 *
 * 路径：src/platform/observability/infrastructure/（PR #32 §2.2 B）。
 *
 * 触发位置：main.ts 与 main.worker.ts 通过 `app.useLogger(adapter)` 注入；
 * NestJS 启动/路由/异常处理等内部日志由此经过 sanitize + NestAppLogger
 * 镜像 stdout，避免敏感字段（如连接字符串、配置值）被原样打到日志。
 *
 * 契约（实现 NestJS LoggerService）：
 * - log/warn/error/debug/verbose：转 LogRecord → sanitize → 调 AppLogger；
 * - setLogLevels：占位空实现——log level 由 1.5 配置骨架统一管理，本适配器
 *   不支持运行时切换。
 *
 * 不做的事：替换应用代码日志——应用代码通过 DI 取 LOG_WRITER / APP_LOGGER；
 * 不引入对外部日志框架的依赖。
 */

import { LoggerService } from '@nestjs/common';

import { type AppLogger } from '../logging/app-logger';
import { type LogRecord, type LogSanitizer } from '../logging/sanitizer';

export interface NestLoggerServiceAdapterOptions {
  readonly sanitizer: LogSanitizer;
  readonly appLogger: AppLogger;
}

export class NestLoggerServiceAdapter implements LoggerService {
  private readonly sanitizer: LogSanitizer;
  private readonly appLogger: AppLogger;

  constructor(options: NestLoggerServiceAdapterOptions) {
    this.sanitizer = options.sanitizer;
    this.appLogger = options.appLogger;
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    const record = this.toRecord('info', message, optionalParams);
    this.appLogger.info(record);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    const record = this.toRecord('warn', message, optionalParams);
    this.appLogger.warn(record);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    const record = this.toRecord('error', message, optionalParams);
    this.appLogger.error(record);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    const record = this.toRecord('debug', message, optionalParams);
    this.appLogger.info(record);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    const record = this.toRecord('verbose', message, optionalParams);
    this.appLogger.info(record);
  }

  // NestJS LoggerService 合约方法；本适配器不接受运行时切换。
  setLogLevels(): void {
    // no-op：log level 由 RanaMinderConfig.observability.logLevel 在 bootstrap 时确定。
  }

  private toRecord(level: string, message: unknown, optionalParams: unknown[]): LogRecord {
    let context: string | undefined;
    let error: unknown;

    if (optionalParams.length >= 1 && typeof optionalParams[0] === 'string') {
      context = optionalParams[0];
    } else if (optionalParams.length >= 1) {
      error = optionalParams[0];
    }

    const record: LogRecord = {
      level,
      message: stringify(message),
    };
    if (context !== undefined) {
      record['context'] = context;
    }
    if (error !== undefined) {
      record['error'] = error instanceof Error ? (error.stack ?? String(error)) : stringify(error);
    }
    return record;
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
