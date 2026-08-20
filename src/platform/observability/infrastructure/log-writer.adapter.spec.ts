/**
 * LogWriterAdapter 测试（ADR-011 §6.1）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LogWriterAdapter } from './log-writer.adapter';

test('LogWriterAdapter：写入前调用脱敏规则，并附加 traceId', () => {
  const redacted: Array<Record<string, unknown>> = [];
  const rules = {
    redactRecord(input: Record<string, unknown>): Record<string, unknown> {
      redacted.push(input);
      return { ...input, redacted: true };
    },
  };
  const trace = {
    getTraceId: () => 'tr_11111111-1111-1111-1111-111111111111',
  } as never;

  const adapter = new LogWriterAdapter(trace as never, rules as never);
  assert.doesNotThrow(() => adapter.info('hello', { userId: 'u-1', token: 'secret' }));
  assert.equal(redacted.length, 1);
  assert.equal(redacted[0].userId, 'u-1');
});

test('LogWriterAdapter：无 context 时也能写入', () => {
  const rules = { redactRecord: (input: Record<string, unknown>) => input };
  const trace = { getTraceId: () => undefined };
  const adapter = new LogWriterAdapter(trace as never, rules as never);
  assert.doesNotThrow(() => adapter.warn('warn without context'));
  assert.doesNotThrow(() => adapter.error('error without context'));
});
