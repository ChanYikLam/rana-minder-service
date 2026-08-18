/**
 * HTTP 请求追踪中间件——把 X-Trace-Id 沿用或新生成 → 写入响应头 →
 * 用 TraceContextAdapter.run 包住整次请求处理。
 *
 * 路径：src/platform/observability/interfaces/（PR #32 §2.2 B）。
 *
 * 触发位置：ObservabilityModule.configure(consumer) 注册到全部路由；
 * 顺序：早于任何 Guard / Interceptor / Pipe，让后续链路在 AsyncLocalStorage
 * 上下文内执行，可由 `TraceContextAdapter.current()` 拿到 traceId。
 *
 * 沿用规则：
 * - 请求头 `X-Trace-Id` 存在且是合法 tr_ 编号 → 沿用；
 * - 否则生成新 trace，并把生成的 traceId 写入响应头回传；
 * - 不强制要求请求头存在（首次访问天然会生成新的）。
 *
 * 不做的事：不读/写业务数据；不改请求/响应主体；不改路由处理结果。
 */

import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

import { TRACE_CONTEXT } from '../tracing/tokens';
import { type TraceContextAdapter } from '../infrastructure/trace-context.adapter';
import { generateTraceId, isTraceId } from '../domain/services/trace-id.generator';
import { TRACE_ID_HEADER } from './trace-headers';

@Injectable()
export class TraceMiddleware implements NestMiddleware {
  constructor(
    @Inject(TRACE_CONTEXT) private readonly ctx: TraceContextAdapter,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = readHeader(req, TRACE_ID_HEADER);
    const traceId = incoming !== undefined && isTraceId(incoming) ? incoming : generateTraceId();

    // 写响应头——后续响应被 NestJS 序列化时带上。
    res.setHeader(TRACE_ID_HEADER, traceId);

    // 用 AsyncLocalStorage 包住 next() 同步返回路径 + 后续 async 链。
    // AsyncLocalStorage 自动跨 Promise/setTimeout/await 传播，下游
    // adapter.current() 可读到本 traceId。
    this.ctx.run({ traceId }, () => next());
  }
}

function readHeader(req: Request, name: string): string | undefined {
  // Express 4 与 5 的 header API 不同：4 返回 string/数组，5 返回 string/undefined。
  const raw = req.headers[name.toLowerCase()];
  if (typeof raw === 'string') {
    return raw;
  }
  if (Array.isArray(raw) && typeof raw[0] === 'string') {
    return raw[0];
  }
  return undefined;
}