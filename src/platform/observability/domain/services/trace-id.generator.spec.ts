/**
 * 追踪编号规则测试（ADR-011 §2.2、XCC-GEN-001）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deriveTrace, generateTraceId, isTraceId, TRACE_PREFIX } from './trace-id.generator';

test('generateTraceId：生成带前缀且可识别的 UUID', () => {
  const id = generateTraceId();
  assert.ok(id.startsWith(TRACE_PREFIX));
  assert.equal(isTraceId(id), true);
});

test('isTraceId：拒绝非法输入', () => {
  assert.equal(isTraceId(''), false);
  assert.equal(isTraceId('tr_abc'), false);
  assert.equal(isTraceId('not-a-trace-id'), false);
});

test('deriveTrace：校验父子编号并保持派生关系', () => {
  const parent = generateTraceId();
  const child = generateTraceId();
  assert.deepEqual(deriveTrace(child, parent), { childTraceId: child, parentTraceId: parent });
  assert.deepEqual(deriveTrace(child), { childTraceId: child, parentTraceId: undefined });
  assert.throws(() => deriveTrace('bad', parent), TypeError);
  assert.throws(() => deriveTrace(child, 'bad'), TypeError);
});
