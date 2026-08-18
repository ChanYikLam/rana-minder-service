import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultLogSanitizer, type LogRecord } from './sanitizer';

describe('sanitizer (DefaultLogSanitizer)', () => {
  it('基础脱敏：forbidden omit / sensitive mask / safe allow', () => {
    const s = new DefaultLogSanitizer();
    const out = s.sanitize({
      userId: 'u1',
      phone: '13800000000',
      'form.responses.q1': 'secret',
    });
    assert.equal(out['userId'], 'u1');
    assert.ok((out['phone'] as string).includes('***'));
    assert.equal('form.responses.q1' in out, false);
  });

  it('extraOmitKeys 强制丢弃额外字段', () => {
    const s = new DefaultLogSanitizer();
    const out = s.sanitize(
      { userId: 'u1', correlationId: 'c1' },
      { extraOmitKeys: ['correlationId'] },
    );
    assert.equal(out['userId'], 'u1');
    assert.equal('correlationId' in out, false);
  });

  it('maxFieldLength 触发 string 截断', () => {
    const s = new DefaultLogSanitizer();
    const longStr = 'x'.repeat(500);
    const out = s.sanitize({ userId: longStr }, { maxFieldLength: 50 });
    assert.ok((out['userId'] as string).endsWith('...[truncated]'));
    assert.ok((out['userId'] as string).length <= 50 + '...[truncated]'.length);
  });

  it('extraOmitKeys 与 redaction 复合：先 redaction 再 extra omit', () => {
    const s = new DefaultLogSanitizer();
    const input: LogRecord = {
      userId: 'u1',
      'form.responses.q1': 'x',
      secretContext: 'y',
    };
    const out = s.sanitize(input, { extraOmitKeys: ['secretContext'] });
    assert.equal(out['userId'], 'u1');
    assert.equal('form.responses.q1' in out, false);
    assert.equal('secretContext' in out, false);
  });
});
