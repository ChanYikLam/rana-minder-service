import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TRACE_PREFIX, generateTraceId, isTraceId, deriveTrace } from './trace-id.generator';

describe('trace-id.generator', () => {
  it('generateTraceId 以 tr_ 开头', () => {
    const id = generateTraceId();
    assert.ok(id.startsWith(TRACE_PREFIX));
    assert.equal(id.length, TRACE_PREFIX.length + 36);
  });

  it('两次生成产生不同 ID', () => {
    const a = generateTraceId();
    const b = generateTraceId();
    assert.notEqual(a, b);
  });

  it('isTraceId 接受合法 ID', () => {
    const id = generateTraceId();
    assert.equal(isTraceId(id), true);
  });

  it('isTraceId 拒绝非 tr_ 前缀', () => {
    assert.equal(isTraceId('xx_' + 'a'.repeat(36)), false);
  });

  it('isTraceId 拒绝空字符串', () => {
    assert.equal(isTraceId(''), false);
  });

  it('isTraceId 拒绝非字符串', () => {
    assert.equal(isTraceId(null), false);
    assert.equal(isTraceId(undefined), false);
    assert.equal(isTraceId(123), false);
  });

  it('deriveTrace 接受 child 与可选 parent', () => {
    const child = generateTraceId();
    const parent = generateTraceId();
    const d = deriveTrace(child, parent);
    assert.equal(d.childTraceId, child);
    assert.equal(d.parentTraceId, parent);
  });

  it('deriveTrace 不带 parent 合法', () => {
    const child = generateTraceId();
    const d = deriveTrace(child);
    assert.equal(d.childTraceId, child);
    assert.equal(d.parentTraceId, undefined);
  });

  it('deriveTrace 非法 child 抛 TypeError', () => {
    assert.throws(() => deriveTrace('not-a-trace'), TypeError);
  });

  it('deriveTrace 非法 parent 抛 TypeError', () => {
    const child = generateTraceId();
    assert.throws(() => deriveTrace(child, 'bad'), TypeError);
  });
});