/**
 * 追踪编号生成与判别规则——纯领域规则。
 *
 * 覆盖：ADR-011 §2.2、XCC-GEN-001、ops/README §6.2。
 *
 * 不混同：业务幂等键由各业务模块按自身作用域（实体 + 命令 + 规范化摘要）自行
 * 生成；本模块不导出任何"业务幂等键"生成函数，调用方不得将本追踪编号用作
 * 业务幂等键（XCC-GEN-001）。
 *
 * 不做：HTTP 请求上下文传递、AsyncLocalStorage 适配、worker 任务上下文串接
 * ——这些由 infrastructure/TraceContextAdapter 承接。
 *
 * 路径迁移：见 src/modules/ops/domain/services/ 同目录其他文件头注释。
 */

import { randomUUID } from 'node:crypto';

export const TRACE_PREFIX = 'tr_';
const TRACE_ID_LENGTH = TRACE_PREFIX.length + 36; // 'tr_' + 标准 UUID（横线）长度

export function generateTraceId(): string {
  return `${TRACE_PREFIX}${randomUUID()}`;
}

export function isTraceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(TRACE_PREFIX) &&
    value.length === TRACE_ID_LENGTH &&
    // 简化校验：第 3、6、9、12 位是 '-'，其余是 hex；不做完整版本位检查以兼容 v7 与 v4。
    value[TRACE_PREFIX.length + 8] === '-' &&
    value[TRACE_PREFIX.length + 13] === '-' &&
    value[TRACE_PREFIX.length + 18] === '-' &&
    value[TRACE_PREFIX.length + 23] === '-'
  );
}

export interface TraceDerivation {
  readonly childTraceId: string;
  readonly parentTraceId?: string;
}

// 派生关系（XCC-GEN-001）通过 trace.parent_id 字段承载，不通过 ID 字符串本身
// 编码。本函数为 TraceContextAdapter 落地时的契约签名，避免后续接入时改动
// 调用方。
export function deriveTrace(childTraceId: string, parentTraceId?: string): TraceDerivation {
  if (!isTraceId(childTraceId)) {
    throw new TypeError(`Invalid trace id: ${String(childTraceId)}`);
  }
  if (parentTraceId !== undefined && !isTraceId(parentTraceId)) {
    throw new TypeError(`Invalid parent trace id: ${String(parentTraceId)}`);
  }
  return { childTraceId, parentTraceId };
}
