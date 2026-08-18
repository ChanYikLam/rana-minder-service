/**
 * 追踪编号语义封装（命名层）。
 *
 * 路径：src/platform/observability/tracing/（PR #32 §2.2 B）。
 *
 * 底层规则由 domain/services/trace-id.generator.ts 提供；本文件只加语义命名
 * 与工厂函数，不重复实现。
 *
 * XCC-GEN-001：追踪编号 ≠ 业务幂等键。本文件不导出任何"业务幂等键"工厂；
 * 调用方需自行业务模块按"实体 + 命令 + 规范化摘要"生成幂等键。
 */

import {
  generateTraceId,
  isTraceId,
  deriveTrace,
  TRACE_PREFIX,
} from '../domain/services/trace-id.generator';

export interface TraceIdFactory {
  // 入口请求生成 root trace。
  createRootTrace(): string;
  // 派生新 child trace（关联关系由调用方记录到 trace.parent_id 字段承载，
  // 不编码进 ID 字符串本身）。
  createChildTrace(parentTraceId: string): string;
}

export class DefaultTraceIdFactory implements TraceIdFactory {
  createRootTrace(): string {
    return generateTraceId();
  }

  createChildTrace(parentTraceId: string): string {
    if (!isTraceId(parentTraceId)) {
      throw new TypeError(`Invalid parent trace id: ${String(parentTraceId)}`);
    }
    return generateTraceId();
  }
}

export { generateTraceId, isTraceId, deriveTrace, TRACE_PREFIX };