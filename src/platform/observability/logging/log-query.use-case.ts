/**
 * 日志查询用例——按追踪编号串起日志。
 *
 * 路径：src/platform/observability/logging/（PR #32 §2.2 B；observability/
 * README §4 / §6.1）。
 *
 * 入口：LogQueryUseCase.execute({ traceId, limit? })。返回**已脱敏**日志
 * 记录数组（顺序按存储层返回顺序；首版不强制时间序）。
 *
 * 边界：
 * - 读侧**再脱敏**：即便存储层在写入时已脱敏，查询时仍跑一次 sanitize——
 *   防御性双层，防止任何一环疏漏；
 * - 不查询业务数据；不调用任何写命令；
 * - 追踪编号合法性由 isTraceId 校验；非法输入直接抛错，避免越权拉日志。
 */

import { isTraceId } from '../domain/services/trace-id.generator';
import { type LogSanitizer, type LogRecord } from './sanitizer';
import { type LogStoragePort } from '../infrastructure/log-storage.port';

export interface LogQueryInput {
  readonly traceId: string;
  readonly limit?: number;
}

export interface LogQueryUseCase {
  execute(input: LogQueryInput): Promise<readonly LogRecord[]>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export class DefaultLogQueryUseCase implements LogQueryUseCase {
  constructor(
    private readonly storage: LogStoragePort,
    private readonly sanitizer: LogSanitizer,
  ) {}

  async execute(input: LogQueryInput): Promise<readonly LogRecord[]> {
    if (!isTraceId(input.traceId)) {
      throw new TypeError(`Invalid trace id: ${String(input.traceId)}`);
    }
    const limit = clampLimit(input.limit ?? DEFAULT_LIMIT);
    const raw = await this.storage.queryByTraceId(input.traceId, limit);
    return raw.map((r) => this.sanitizer.sanitize(r));
  }
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(MAX_LIMIT, Math.floor(value));
}