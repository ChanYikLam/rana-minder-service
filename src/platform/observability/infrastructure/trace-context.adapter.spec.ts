import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTraceContextAdapter } from './trace-context.adapter';
import { generateTraceId } from '../domain/services/trace-id.generator';

describe('trace-context.adapter (AsyncLocalStorage)', () => {
  const adapter = createTraceContextAdapter();

  it('run 注入并取出同一上下文', () => {
    const id = generateTraceId();
    const seen = adapter.run({ traceId: id }, () => adapter.current()?.traceId);
    assert.equal(seen, id);
  });

  it('runWithNewChild 派生 child trace', () => {
    const parentId = generateTraceId();
    const child = adapter.runWithNewChild(
      { traceId: parentId },
      () => adapter.current(),
    );
    assert.ok(child);
    assert.ok(child.traceId.startsWith('tr_'));
    assert.notEqual(child.traceId, parentId);
    assert.equal(child.parentTraceId, parentId);
  });

  it('runWithNewRoot 不携带 parent', () => {
    const ctx = adapter.runWithNewRoot(() => adapter.current());
    assert.ok(ctx);
    assert.ok(ctx.traceId.startsWith('tr_'));
    assert.equal(ctx.parentTraceId, undefined);
  });

  it('嵌套 run：内层覆盖外层', () => {
    const outer = generateTraceId();
    const inner = generateTraceId();
    const out = adapter.run({ traceId: outer }, () =>
      adapter.run({ traceId: inner }, () => adapter.current()?.traceId),
    );
    assert.equal(out, inner);
    assert.equal(adapter.current(), undefined);
  });

  it('异步上下文传递：在 setTimeout 回调中仍能取到', async () => {
    const id = generateTraceId();
    const seen = await adapter.run({ traceId: id }, () =>
      new Promise<string | undefined>((resolve) => {
        setTimeout(() => resolve(adapter.current()?.traceId), 10);
      }),
    );
    assert.equal(seen, id);
  });

  it('非法 parent 抛 TypeError', () => {
    assert.throws(
      () => adapter.runWithNewChild({ traceId: 'bad' }, () => undefined),
      TypeError,
    );
  });
});