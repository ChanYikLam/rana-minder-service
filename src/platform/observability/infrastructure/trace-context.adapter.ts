/**
 * 追踪上下文适配器（ADR-011 §2.2）。
 *
 * 使用 AsyncLocalStorage 在 HTTP 请求、后台任务和外部调用之间传递唯一追踪编号。
 * 追踪编号只用于关联，不用于业务幂等；调用方不得把 traceId 当作幂等键。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable } from '@nestjs/common';

import { deriveTrace, generateTraceId, isTraceId } from '../domain/services/trace-id.generator';

export interface TraceContext {
  readonly traceId: string;
  readonly parentTraceId?: string;
}

export interface RunWithTraceOptions {
  readonly parentTraceId?: string;
}

@Injectable()
export class TraceContextAdapter {
  private readonly storage = new AsyncLocalStorage<TraceContext>();

  /**
   * 在给定上下文中执行操作；未指定 parentTraceId 时生成全新根追踪编号。
   */
  runWithTrace<T>(operation: () => T, options: RunWithTraceOptions = {}): T {
    const parentTraceId = options.parentTraceId;
    if (parentTraceId !== undefined && !isTraceId(parentTraceId)) {
      throw new TypeError(`Invalid parent trace id: ${String(parentTraceId)}`);
    }
    const traceId = generateTraceId();
    const derived = deriveTrace(traceId, parentTraceId);
    const context: TraceContext = {
      traceId: derived.childTraceId,
      parentTraceId: derived.parentTraceId,
    };
    return this.storage.run(context, operation);
  }

  /**
   * 异步版本：AsyncLocalStorage 在 Promise 链中依然保持上下文。
   */
  async runWithTraceAsync<T>(
    operation: () => Promise<T>,
    options: RunWithTraceOptions = {},
  ): Promise<T> {
    return this.runWithTrace(operation, options);
  }

  getTraceId(): string | undefined {
    return this.storage.getStore()?.traceId;
  }

  getParentTraceId(): string | undefined {
    return this.storage.getStore()?.parentTraceId;
  }

  getContext(): TraceContext | undefined {
    return this.storage.getStore();
  }
}
