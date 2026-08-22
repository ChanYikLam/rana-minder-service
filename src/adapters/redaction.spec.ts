/**
 * T3 外部调用错误脱敏工具单元测试。
 *
 * 覆盖：密钥/令牌/连接串强制遮蔽、URL 查询参数折叠、截断、敏感内容拒绝回显。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactMessage, looksSensitive, toRedactedErrorSummary } from './redaction';

describe('redactMessage（外部错误脱敏）', () => {
  it('遮蔽 client_secret/access_key/password 值', () => {
    const out = redactMessage('casdoor client_secret=abc123 def password=xyz');
    assert.ok(!out.includes('abc123'));
    assert.ok(!out.includes('xyz'));
    assert.ok(out.includes('***'));
  });

  it('遮蔽 URL 查询参数中的 key/secret/token', () => {
    const out = redactMessage('https://host/api?token=abc&sig=xyz&ok=1');
    assert.ok(!out.includes('abc'));
    assert.ok(!out.includes('xyz'));
  });

  it('超过最大长度截断', () => {
    const long = 'x'.repeat(500);
    const out = redactMessage(long, 100);
    assert.ok(out.length <= 101);
    assert.ok(out.endsWith('…'));
  });
});

describe('looksSensitive / toRedactedErrorSummary', () => {
  it('含密钥时 looksSensitive 为 true', () => {
    assert.equal(looksSensitive('token=abc'), true);
    assert.equal(looksSensitive('普通错误'), false);
  });

  it('敏感错误摘要不回显原始内容', () => {
    const summary = toRedactedErrorSummary(new Error('client_secret=supersecret'));
    assert.equal(summary, 'external-error-redacted');
    assert.ok(!summary.includes('supersecret'));
  });

  it('普通错误摘要脱敏并保留', () => {
    const summary = toRedactedErrorSummary(new Error('connection timeout'));
    assert.equal(summary, 'connection timeout');
  });

  it('字符串错误与未知类型', () => {
    assert.equal(toRedactedErrorSummary('timeout'), 'timeout');
    assert.equal(toRedactedErrorSummary(null), 'external-error');
  });
});
