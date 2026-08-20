/**
 * 脱敏规则测试（ADR-011 §2.1、AUD-013/AUD-014）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decide, redactRecord } from './redaction.rules';

test('decide：安全字段放行，敏感字段遮蔽，禁止字段丢弃，未知字段截断', () => {
  assert.equal(decide('traceId').kind, 'allow');
  assert.equal(decide('userId').kind, 'allow');
  assert.equal(decide('token').kind, 'mask');
  assert.equal(decide('password').kind, 'mask');
  assert.equal(decide('form.responses.answer').kind, 'omit');
  assert.equal(decide('message').kind, 'truncate');
});

test('redactRecord：输出不包含禁止字段，敏感字段不可逆，安全字段保留', () => {
  const input = {
    traceId: 'tr_12345678-1234-1234-1234-123456789abc',
    userId: 'user-1',
    token: 'secret-token-value',
    password: 'p@ss',
    'form.responses.answer': '不应出现在日志',
    message: 'x'.repeat(500),
  };

  const out = redactRecord(input);

  assert.equal(out.traceId, input.traceId);
  assert.equal(out.userId, input.userId);
  assert.equal(out.token, 'secr***[len=18]');
  assert.equal(out.password, '***');
  assert.equal('form.responses.answer' in out, false);
  assert.match(out.message as string, /\[truncated\]$/);
});
