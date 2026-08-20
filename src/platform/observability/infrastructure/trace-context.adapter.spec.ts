/**
 * TraceContextAdapter 测试（ADR-011 §2.2）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TraceContextAdapter } from './trace-context.adapter';
import { isTraceId } from '../domain/services/trace-id.generator';

test('runWithTrace：上下文内可读取 traceId，外部不可见', () => {
  const adapter = new TraceContextAdapter();
  assert.equal(adapter.getTraceId(), undefined);

  adapter.runWithTrace(() => {
    assert.ok(isTraceId(adapter.getTraceId() as string));
  });

  assert.equal(adapter.getTraceId(), undefined);
});

test('runWithTrace：支持父追踪编号派生', () => {
  const adapter = new TraceContextAdapter();
  const parent = 'tr_11111111-1111-1111-1111-111111111111';

  adapter.runWithTrace(
    () => {
      assert.equal(adapter.getParentTraceId(), parent);
      assert.notEqual(adapter.getTraceId(), parent);
    },
    { parentTraceId: parent },
  );
});

test('runWithTraceAsync：Promise 链路保持上下文', async () => {
  const adapter = new TraceContextAdapter();
  const traceId = await adapter.runWithTraceAsync(async () => {
    const id = adapter.getTraceId() as string;
    await Promise.resolve();
    assert.equal(adapter.getTraceId(), id);
    return id;
  });
  assert.ok(isTraceId(traceId));
  assert.equal(adapter.getTraceId(), undefined);
});
