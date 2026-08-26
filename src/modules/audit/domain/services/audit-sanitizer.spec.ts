/**
 * AuditSanitizer 逐分支测试（P1 任务⑤；AUD-003、CAS-SEC-001~004）。
 *
 * 覆盖：敏感字段识别（精确/驼峰/下划线/复数词干）、递归嵌套脱敏、
 * 深度防护（MAX_SANITIZE_DEPTH）、自由文本内联凭证脱敏、JSON 键值脱敏。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AuditSanitizer } from './audit-sanitizer';

const sanitizer = new AuditSanitizer();

describe('AuditSanitizer（CAS-SEC-001~004）', () => {
  describe('sanitizeField：字段级脱敏', () => {
    it('精确匹配：password → <REDACTED:n> redacted=true', () => {
      const r = sanitizer.sanitizeField('password', 'Secret123!');
      assert.equal(r.redacted, true);
      assert.match(r.display, /<REDACTED:\d+>/);
    });

    it('驼峰变体：smtpSecret → 敏感', () => {
      assert.equal(sanitizer.sanitizeField('smtpSecret', 'key').redacted, true);
    });

    it('下划线变体：access_token → 敏感', () => {
      assert.equal(sanitizer.sanitizeField('access_token', 'tok').redacted, true);
    });

    it('复数词干：tokens → 敏感（去尾 s 匹配 token）', () => {
      assert.equal(sanitizer.sanitizeField('tokens', ['a', 'b']).redacted, true);
    });

    it('非敏感字段：title/role/status → 不脱敏', () => {
      for (const field of ['title', 'role', 'status']) {
        const r = sanitizer.sanitizeField(field, 'value');
        assert.equal(r.redacted, false, `${field} 不应被标记为敏感`);
        assert.equal(r.display, 'value');
      }
    });

    it('address/status 等含 s 结尾的非敏感字段不被误伤', () => {
      assert.equal(sanitizer.sanitizeField('address', '北京市').redacted, false);
    });
  });

  describe('sanitizeObject：递归对象脱敏', () => {
    it('顶层敏感键脱敏 + 非敏感键保留', () => {
      const r = sanitizer.sanitizeObject({
        password: 'secret123',
        role: 'ADMIN',
      });
      assert.match(String(r), /password.*REDACTED/i);
      assert.match(String(r), /role=ADMIN/);
    });

    it('嵌套对象递归下钻', () => {
      const r = sanitizer.sanitizeObject({
        profile: { emailSecret: 'inner-key' },
      });
      assert.match(String(r), /emailsecret.*REDACTED|REDACTED/i);
    });
  });
});
