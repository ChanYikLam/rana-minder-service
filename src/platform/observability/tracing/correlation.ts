/**
 * 追踪关联语义——XCC-GEN-001 不变量落地。
 *
 * 路径：src/platform/observability/tracing/（PR #32 §2.2 B）。
 *
 * 核心不变量：
 * - 业务幂等键由各业务模块按自身作用域（实体 + 命令 + 规范化摘要）生成；
 * - 追踪编号由 observability/tracing/trace-id.ts 的工厂函数生成；
 * - 二者通过 trace.parent_id 或审计关联表分别承载，**不得混同**。
 *
 * 本文件不实现"业务幂等键生成"——那是业务模块的责任。本文件只做边界断言：
 * - 调用方传入 CorrelationKey 时，校验 traceId 合法；
 * - 若同时传入 idempotencyKey，校验它不是 traceId（防呆）。
 */

import { isTraceId } from '../domain/services/trace-id.generator';

export interface CorrelationKey {
  readonly traceId: string;
  readonly idempotencyKey?: string;
}

// 业务幂等键约定：`<scope>:<normalized-hash>`。scope 通常为小写字母+下划线开头
// 的命名空间（如 `recruitment:apply`、`membership:transfer`）；规范化摘要通常
// 为 base64url 或 hex 编码。首版只做"形式"软约束，scope 是否合规留给业务模块
// 自行保证；本守卫首要任务是"不能混同"。
const IDEMPOTENCY_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}:[A-Za-z0-9_-]{1,128}$/;

export class CorrelationDistinctViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorrelationDistinctViolation';
  }
}

export interface Correlation {
  assert(correlation: CorrelationKey): void;
  isTraceIdLike(value: unknown): boolean;
  isIdempotencyKeyLike(value: unknown): boolean;
}

export class DefaultCorrelation implements Correlation {
  assert(correlation: CorrelationKey): void {
    if (!isTraceId(correlation.traceId)) {
      throw new TypeError(`Invalid trace id: ${String(correlation.traceId)}`);
    }
    const idempotencyKey = correlation.idempotencyKey;
    if (idempotencyKey !== undefined) {
      if (idempotencyKey.length === 0) {
        throw new CorrelationDistinctViolation('XCC-GEN-001: idempotency key must not be empty');
      }
      if (isTraceId(idempotencyKey)) {
        throw new CorrelationDistinctViolation(
          'XCC-GEN-001: idempotency key must not be a trace id',
        );
      }
    }
  }

  isTraceIdLike(value: unknown): boolean {
    return isTraceId(value);
  }

  isIdempotencyKeyLike(value: unknown): boolean {
    if (typeof value !== 'string' || value.length === 0) {
      return false;
    }
    if (isTraceId(value)) {
      return false;
    }
    return IDEMPOTENCY_KEY_PATTERN.test(value);
  }
}
