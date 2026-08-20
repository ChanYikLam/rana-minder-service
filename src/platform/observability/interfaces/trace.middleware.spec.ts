import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TraceMiddleware } from './trace.middleware';
import { createTraceContextAdapter } from '../infrastructure/trace-context.adapter';
import { generateTraceId, isTraceId } from '../domain/services/trace-id.generator';
import { TRACE_ID_HEADER } from './trace-headers';
import type { TraceContextAdapter } from '../infrastructure/trace-context.adapter';

interface MockReq {
  headers: Record<string, string | string[] | undefined>;
  header(name: string): string | undefined;
}

interface MockRes {
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
}

const makeReq = (headers: Record<string, string>): MockReq => ({
  headers,
  header(name: string): string | undefined {
    const v = headers[name.toLowerCase()];
    if (typeof v === 'string') {
      return v;
    }
    return undefined;
  },
});

const makeRes = (): MockRes => {
  const r: MockRes = {
    headers: {},
    setHeader(name: string, value: string): void {
      r.headers[name] = value;
    },
  };
  return r;
};

describe('TraceMiddleware', () => {
  const ctx: TraceContextAdapter = createTraceContextAdapter();

  it('合法 X-Trace-Id 头：沿用并写回响应头', () => {
    const traceId = generateTraceId();
    const mw = new TraceMiddleware(ctx);
    const req = makeReq({ 'x-trace-id': traceId });
    const res = makeRes();
    let nextCalled = false;
    mw.use(req as never, res as never, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(res.headers[TRACE_ID_HEADER], traceId);
  });

  it('非法 X-Trace-Id 头：生成新 trace 并写回响应头', () => {
    const mw = new TraceMiddleware(ctx);
    const req = makeReq({ 'x-trace-id': 'not-a-trace' });
    const res = makeRes();
    mw.use(req as never, res as never, () => undefined);
    const id = res.headers[TRACE_ID_HEADER];
    assert.ok(id !== undefined);
    assert.equal(isTraceId(id), true);
  });

  it('无 X-Trace-Id 头：生成新 trace', () => {
    const mw = new TraceMiddleware(ctx);
    const req = makeReq({});
    const res = makeRes();
    mw.use(req as never, res as never, () => undefined);
    const id = res.headers[TRACE_ID_HEADER];
    assert.equal(typeof id, 'string');
    assert.equal(isTraceId(id), true);
  });

  it('ctx.run 包住 next：next 同步路径内 current() 返回 traceId', () => {
    const mw = new TraceMiddleware(ctx);
    const req = makeReq({});
    const res = makeRes();
    let observed: string | undefined;
    mw.use(req as never, res as never, () => {
      observed = ctx.current()?.traceId;
    });
    assert.equal(observed, res.headers[TRACE_ID_HEADER]);
  });

  it('ctx.run 包住 next：异步路径内 current() 仍可取到', async () => {
    const mw = new TraceMiddleware(ctx);
    const req = makeReq({});
    const res = makeRes();
    const seen = await new Promise<string | undefined>((resolve) => {
      mw.use(req as never, res as never, () => {
        setTimeout(() => resolve(ctx.current()?.traceId), 10);
      });
    });
    assert.equal(seen, res.headers[TRACE_ID_HEADER]);
  });

  it('next 完成后 ctx 自动退出', () => {
    const mw = new TraceMiddleware(ctx);
    const req = makeReq({});
    const res = makeRes();
    mw.use(req as never, res as never, () => undefined);
    assert.equal(ctx.current(), undefined);
  });
});
