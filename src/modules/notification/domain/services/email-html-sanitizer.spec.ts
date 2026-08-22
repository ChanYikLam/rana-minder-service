/**
 * 邮件 HTML 净化器测试（NTF-005）。
 * 覆盖：脚本/表单/iframe/自动跳转/外链 CSS/事件处理器/危险协议清除，
 * 受限行内样式保留，HTTPS 链接策略，外部图片允许。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeEmailHtml } from './email-html-sanitizer';

describe('sanitizeEmailHtml（NTF-005 模板安全）', () => {
  it('安全排版 HTML 原样保留', () => {
    const input = '<p style="color: red; font-size: 14px">你好 <strong>同学</strong></p>';
    const result = sanitizeEmailHtml(input);
    assert.equal(result.hadViolations, false);
    assert.ok(result.html.includes('<p'));
    assert.ok(result.html.includes('color: red'));
    assert.ok(result.html.includes('<strong>同学</strong>'));
  });

  it('script 标签连同内容整体删除', () => {
    const result = sanitizeEmailHtml('<p>a</p><script>alert(1)</script><p>b</p>');
    assert.ok(!result.html.includes('script'), result.html);
    assert.ok(!result.html.includes('alert'), '脚本内容不得残留');
    assert.ok(result.html.includes('<p>a</p>'));
    assert.ok(result.hadViolations);
  });

  it('form/input/button 等表单元素删除', () => {
    const result = sanitizeEmailHtml(
      '<form action="/x"><input type="text"><button>提交</button></form>',
    );
    assert.ok(!result.html.includes('form'));
    assert.ok(!result.html.includes('input'));
    assert.ok(!result.html.includes('button'));
  });

  it('iframe 与 meta refresh（自动跳转）删除', () => {
    const result = sanitizeEmailHtml(
      '<iframe src="https://evil.example"></iframe><meta http-equiv="refresh" content="0;url=https://evil.example">',
    );
    assert.ok(!result.html.includes('iframe'));
    assert.ok(!result.html.includes('meta'));
    assert.ok(!result.html.includes('refresh'));
  });

  it('style 标签（外链/内嵌 CSS）删除，行内样式受限保留', () => {
    const result = sanitizeEmailHtml(
      '<style>body { background: url(https://evil.example/t.gif) }</style><p style="position: fixed; color: blue">x</p>',
    );
    assert.ok(!result.html.includes('<style'));
    // position 不在白名单属性中 → 移除；color 保留
    assert.ok(!result.html.includes('position'));
    assert.ok(result.html.includes('color: blue'));
  });

  it('事件处理器属性全部移除', () => {
    const result = sanitizeEmailHtml('<p onmouseover="steal()" onclick="x()">hi</p>');
    assert.ok(!result.html.includes('onmouseover'));
    assert.ok(!result.html.includes('onclick'));
    assert.ok(result.html.includes('hi'));
  });

  it('javascript:/data: 等危险协议链接移除；HTTP 外链移除；HTTPS 保留', () => {
    const result = sanitizeEmailHtml(
      '<a href="javascript:alert(1)">a</a><a href="http://insecure.example">b</a><a href="https://ok.example">c</a>',
    );
    assert.ok(!result.html.includes('javascript:'));
    assert.ok(!result.html.includes('http://insecure.example'));
    assert.ok(result.html.includes('https://ok.example'));
  });

  it('站内相对路径链接保留（打开时重新鉴权）', () => {
    const result = sanitizeEmailHtml('<a href="/recruitment/apply/42">查看</a>');
    assert.ok(result.html.includes('href="/recruitment/apply/42"'));
    assert.equal(result.hadViolations, false);
  });

  it('外部图片 http(s) 允许（治理清单承接跟踪风险），data: 图片拒绝', () => {
    const ok = sanitizeEmailHtml('<img src="https://cdn.example/logo.png" alt="logo">');
    assert.ok(ok.html.includes('src="https://cdn.example/logo.png"'));
    const bad = sanitizeEmailHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">');
    assert.ok(!bad.html.includes('data:'));
  });
});
