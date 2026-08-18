import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decide, redactRecord, redactValue, DEFAULT_TRUNCATE_MAX } from './redaction.rules';

describe('redaction.rules', () => {
  describe('decide()', () => {
    it('FORBIDDEN key 命中 → omit', () => {
      assert.deepEqual(decide('form.responses.0'), { kind: 'omit' });
      assert.deepEqual(decide('evaluation.content'), { kind: 'omit' });
      assert.deepEqual(decide('audit.raw'), { kind: 'omit' });
    });

    it('SAFE key 命中 → allow', () => {
      assert.deepEqual(decide('userId'), { kind: 'allow' });
      assert.deepEqual(decide('status'), { kind: 'allow' });
      assert.deepEqual(decide('_traceId'), { kind: 'allow' });
    });

    it('SENSITIVE key 命中 → mask', () => {
      const d = decide('phone');
      assert.equal(d.kind, 'mask');
    });

    it('PATH key 命中 → mask with hint=path', () => {
      assert.deepEqual(decide('path'), { kind: 'mask', hint: 'path' });
    });

    it('未命中任何列表 → 默认 truncate(200)', () => {
      assert.deepEqual(decide('somethingUnknown'), {
        kind: 'truncate',
        max: DEFAULT_TRUNCATE_MAX,
      });
    });
  });

  describe('redactValue()', () => {
    it('mask 对 8 字符以内返回 ***', () => {
      assert.equal(redactValue('abcdef', { kind: 'mask' }), '***');
    });

    it('mask 对长字符串保留前 4 位 + 长度提示', () => {
      const v = redactValue('abcdefghijklmnop', { kind: 'mask' });
      assert.equal(v, 'abcd***[len=16]');
    });

    it('truncate 超过 max 加 [truncated]', () => {
      const long = 'x'.repeat(300);
      const v = redactValue(long, { kind: 'truncate', max: 10 });
      assert.equal(typeof v, 'string');
      assert.ok((v as string).endsWith('...[truncated]'));
    });

    it('mask path 按段首字母+***', () => {
      const v = redactValue('/var/lib/postgres', { kind: 'mask', hint: 'path' });
      assert.equal(v, '/v***/l***/p***');
    });

    it('mask path：单段也按规则遮蔽', () => {
      const v = redactValue('/var', { kind: 'mask', hint: 'path' });
      assert.equal(v, '/v***');
    });
  });

  describe('redactRecord()', () => {
    it('drop forbidden keys 整字段丢弃', () => {
      const out = redactRecord({ id: 'u1', 'form.responses.0': 'secret' });
      assert.deepEqual(Object.keys(out).sort(), ['id']);
    });

    it('mask sensitive values', () => {
      const out = redactRecord({ phone: '13800000000' });
      assert.ok((out['phone'] as string).startsWith('1380'));
      assert.ok((out['phone'] as string).includes('***'));
    });

    it('keep safe keys 原样', () => {
      const out = redactRecord({ userId: 'u1', status: 'ok' });
      assert.equal(out['userId'], 'u1');
      assert.equal(out['status'], 'ok');
    });

    it('混合字段：safe/sensitive/forbidden 三类同时存在', () => {
      const out = redactRecord({
        userId: 'u1',
        phone: '13800000000',
        'form.responses.q1': 'hello',
        path: '/var/lib',
      });
      assert.equal(out['userId'], 'u1');
      assert.ok((out['phone'] as string).includes('***'));
      assert.equal(out['path'] as string, '/v***/l***');
      assert.equal('form.responses.q1' in out, false);
    });
  });
});
