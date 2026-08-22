/**
 * 邮件模板渲染与安全校验测试（NTF-005）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderEmailTemplate,
  validateTemplateSafety,
  TEMPLATE_VARIABLE_WHITELIST,
} from './email-template';

describe('renderEmailTemplate（NTF-005.7 白名单变量自动转义）', () => {
  it('白名单变量替换并 HTML 转义', () => {
    const result = renderEmailTemplate(
      '【{{clubName}}】结果通知',
      '<p>{{studentName}} 同学你好</p>',
      { studentName: '张<b>三', clubName: '动漫社' },
    );
    assert.equal(result.subject, '【动漫社】结果通知');
    assert.ok(result.htmlBody.includes('张&lt;b&gt;三'), '变量值必须转义');
    assert.ok(!result.htmlBody.includes('<b>'));
    assert.equal(result.ignoredVariables.length, 0);
  });

  it('非白名单占位符转义为惰性文本并记录名称（不读取任意字段）', () => {
    const result = renderEmailTemplate('x', '<p>{{internalScore}}</p>', {
      internalScore: '59',
    } as never);
    assert.deepEqual(result.ignoredVariables, ['internalScore']);
    // 占位符原样保留但已转义，不会展开任何未授权数据
    assert.ok(result.htmlBody.includes('{{internalScore}}'));
    assert.ok(!result.htmlBody.includes('59'));
  });
});

describe('validateTemplateSafety（NTF-005.5 + NTF-008.3）', () => {
  it('安全模板通过并返回净化 HTML', () => {
    const result = validateTemplateSafety('结果通知', '<p style="color: red">恭喜</p>');
    assert.equal(result.safe, true);
    assert.ok(result.sanitizedHtml?.includes('<p'));
  });

  it('脚本/表单/iframe/危险协议 → 不安全并列出违规', () => {
    for (const body of [
      '<script>alert(1)</script>',
      '<form action="/steal"><input></form>',
      '<iframe src="https://evil.example"></iframe>',
      '<a href="javascript:void(0)">x</a>',
      '<meta http-equiv="refresh" content="0">',
    ]) {
      const result = validateTemplateSafety('s', body);
      assert.equal(result.safe, false, body);
      assert.ok(result.violations.length > 0);
      assert.equal(result.sanitizedHtml, null);
    }
  });

  it('主题含换行或 HTML 标记 → 不安全（头注入防护）', () => {
    assert.equal(validateTemplateSafety('a\r\nBcc: x@y.com', '<p>x</p>').safe, false);
    assert.equal(validateTemplateSafety('<b>bold</b>', '<p>x</p>').safe, false);
  });

  it('模板试图声明发件身份 → 不安全（NTF-008.3）', () => {
    const result = validateTemplateSafety('s', '<p>From: fake@example.com</p>');
    assert.equal(result.safe, false);
    assert.ok(result.violations.some((v) => v.includes('发件身份')));
  });

  it('白名单常量覆盖平台展示名等必要变量', () => {
    assert.ok(TEMPLATE_VARIABLE_WHITELIST.includes('platformName'));
    assert.ok(TEMPLATE_VARIABLE_WHITELIST.includes('studentName'));
  });
});
