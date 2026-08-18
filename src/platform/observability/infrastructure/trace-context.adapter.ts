/**
 * 追踪上下文传递适配——HTTP 请求 → 应用命令 → 外部调用/后台任务。
 *
 * 路径：src/platform/observability/infrastructure/（PR #32 §2.2 B）。
 *
 * 使用 Node `AsyncLocalStorage` 在调用栈内隐式传递 trace context，**无需**
 * 业务代码显式传 trace 参数。
 *
 * 不做：
 * - 跨进程 / 跨 HTTP 实例的 trace 上下文恢复（需通过 HTTP 请求头
 *   `X-Trace-Id` 显式传递，由 HTTP 适配层在 7️⃣ 阶段接入）；
 * - 异步队列/任务系统的上下文串接（worker 入口由 worker bootstrap 在
 *   7️⃣ 阶段接入 `runWithNewRoot`）；
 * - 业务幂等键（XCC-GEN-001）。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  generateTraceId,
  isTraceId,
} from '../domain/services/trace-id.generator';

export interface TraceContext {
  readonly traceId: string;
  readonly parentTraceId?: string;
}

export interface TraceContextAdapter {
  run<T>(ctx: TraceContext, fn: () => T): T;
  runWithNewChild<T>(parent: TraceContext, fn: () => T): T;
  runWithNewRoot<T>(fn: () => T): T;
  current(): TraceContext | undefined;
}

class AsyncLocalStorageTraceContext implements TraceContextAdapter {
  private readonly als = new AsyncLocalStorage<TraceContext>();

  run<T>(ctx: TraceContext, fn: () => T): T {
    return this.als.run(ctx, fn);
  }

  runWithNewChild<T>(parent: TraceContext, fn: () => T): T {
    if (!isTraceId(parent.traceId)) {
      throw new TypeError(`Invalid parent trace id: ${String(parent.traceId)}`);
    }
    return this.als.run(
      { traceId: generateTraceId(), parentTraceId: parent.traceId },
      fn,
    );
  }

  runWithNewRoot<T>(fn: () => T): T {
    return this.als.run({ traceId: generateTraceId() }, fn);
  }

  current(): TraceContext | undefined {
    return this.als.getStore();
  }
}

export function createTraceContextAdapter(): TraceContextAdapter {
  return new AsyncLocalStorageTraceContext();
}