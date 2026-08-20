/**
 * HTTP 追踪上下文中间件（ADR-011 §2.2）。
 *
 * 每个 HTTP 请求进入时创建唯一追踪编号，并通过 TraceContextAdapter 在请求处理
 * 链路（管道、守卫、拦截器、控制器、外部调用）中保持上下文。
 *
 * 使用：在 main.ts 中 `app.use(new TraceContextMiddleware(adapter).use)` 或注册为
 * Nest 中间件；worker 入口不使用本中间件，改用 TraceContextAdapter.runWithTraceAsync。
 */
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import type { TraceContextAdapter } from './trace-context.adapter';

@Injectable()
export class TraceContextMiddleware implements NestMiddleware {
  constructor(private readonly traceContext: TraceContextAdapter) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    this.traceContext.runWithTrace(next);
  }
}
