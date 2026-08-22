/**
 * 邮件 HTML 模板净化器（NTF-005、需求发现 08「默认模板与社团 HTML 模板」）。
 *
 * 规则（产品行为已冻结，需求发现 08 §默认模板与社团 HTML 模板 5-7）：
 * - 允许常见排版标签与受限行内样式；
 * - 禁止脚本、表单、iframe、自动跳转、外部 JavaScript/CSS、可执行内容和危险协议；
 * - 普通链接只允许 HTTPS；业务操作按钮只能链接本系统；
 * - 允许使用外部图片（第三方跟踪风险进入治理清单，不在代码层禁止）。
 *
 * 本净化器是白名单实现：先解析移除一切未明确允许的内容，
 * 再对保留属性做协议与样式属性级过滤。输出保证不含
 * script/form/iframe/meta refresh/事件处理器/外链 JS/CSS。
 */

/** 净化结果 */
export interface SanitizeResult {
  /** 净化后的 HTML（安全可发送） */
  readonly html: string;
  /** 违规项描述（用于审计与预览提示；不回显原始恶意内容全文） */
  readonly violations: readonly string[];
  /** 是否存在被清除的危险内容 */
  readonly hadViolations: boolean;
}

/** 允许的排版标签（白名单） */
const ALLOWED_TAGS = new Set([
  'p',
  'div',
  'span',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'blockquote',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'a',
  'img',
]);

/** 自闭合标签 */
const VOID_TAGS = new Set(['br', 'hr', 'img']);

/**
 * 必须整体删除的标签（含内容）：脚本、样式、表单控件、内嵌框架、
 * 元信息（自动跳转）、外链 CSS/字体、可执行对象。
 */
const STRIP_WITH_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'form',
  'input',
  'button',
  'select',
  'option',
  'textarea',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'svg',
  'math',
  'noscript',
  'template',
  'audio',
  'video',
  'source',
  'track',
]);

/** 行内样式允许的 CSS 属性（受限行内样式） */
const ALLOWED_STYLE_PROPERTIES = new Set([
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'font-style',
  'font-family',
  'text-align',
  'text-decoration',
  'line-height',
  'letter-spacing',
  'margin',
  'margin-top',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'padding',
  'padding-top',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'border',
  'border-radius',
  'border-color',
  'width',
  'max-width',
  'min-width',
  'height',
  'display',
  'vertical-align',
  'white-space',
]);

/** 各标签允许的属性（白名单；style 单独按属性过滤） */
const ALLOWED_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
};

/** 危险 URL 协议（一律拒绝） */
const DANGEROUS_URL_PROTOCOLS = /^(javascript|vbscript|file|data|blob|about):/i;

/** 校验普通链接：只允许 HTTPS 或本系统相对路径（需求发现 08 §模板 7） */
function isSafeLinkUrl(url: string): boolean {
  const trimmed = url.trim();
  // 站内相对路径（打开时重新鉴权）；拒绝 // 协议相对 URL（可指向任意外部 http/https 站点）
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
  if (/^https:/i.test(trimmed)) return true;
  return false;
}

/** 校验图片地址：允许 http(s) 外链图片（治理清单承接跟踪风险），拒绝危险协议 */
function isSafeImageUrl(url: string): boolean {
  const trimmed = url.trim();
  if (/^https?:/i.test(trimmed)) return true;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
  return false;
}

function sanitizeStyle(styleValue: string): string | null {
  const declarations = styleValue.split(';');
  const kept: string[] = [];
  for (const declaration of declarations) {
    const idx = declaration.indexOf(':');
    if (idx <= 0) continue;
    const property = declaration.slice(0, idx).trim().toLowerCase();
    const value = declaration.slice(idx + 1).trim();
    if (!property || !value) continue;
    // 值中不允许出现 url() 与表达式/导入等可执行载体
    if (/url\s*\(|expression|@import|behavior/i.test(value)) continue;
    if (!ALLOWED_STYLE_PROPERTIES.has(property)) continue;
    kept.push(property + ': ' + value);
  }
  return kept.length > 0 ? kept.join('; ') : null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 净化邮件 HTML 模板。
 * 白名单实现：未识别标签按纯文本转义保留文字内容，
 * 危险标签连同内容整体删除并记录违规。
 */
export function sanitizeEmailHtml(input: string): SanitizeResult {
  const violations: string[] = [];
  let out = '';
  let i = 0;
  const len = input.length;
  // 标签栈：用于在遇到结束标签时正确闭合已输出的开始标签
  const stack: string[] = [];

  const emitCloseFor = (tag: string): void => {
    const idx = stack.lastIndexOf(tag);
    if (idx >= 0) {
      for (let k = stack.length - 1; k >= idx; k -= 1) {
        out += '</' + stack[k] + '>';
      }
      stack.length = idx;
    }
  };

  while (i < len) {
    const lt = input.indexOf('<', i);
    if (lt < 0) {
      out += escapeHtml(input.slice(i));
      break;
    }
    out += escapeHtml(input.slice(i, lt));

    // 注释整段删除
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      i = end < 0 ? len : end + 3;
      continue;
    }

    const gt = input.indexOf('>', lt);
    if (gt < 0) {
      out += escapeHtml(input.slice(lt));
      break;
    }

    const rawTag = input.slice(lt + 1, gt);
    const isClosing = rawTag.startsWith('/');
    const tagNameMatch = rawTag.match(/^\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/);
    const tagName = (tagNameMatch?.[1] ?? '').toLowerCase();

    if (!tagName) {
      // 不是合法标签，按文本转义
      out += escapeHtml(input.slice(lt, gt + 1));
      i = gt + 1;
      continue;
    }

    if (STRIP_WITH_CONTENT.has(tagName)) {
      // 连同内容一起删除：找到对应结束标签
      violations.push('已移除禁止元素 <' + tagName + '>');
      const closePattern = new RegExp('</\\s*' + tagName + '\\s*>', 'i');
      const rest = input.slice(gt + 1);
      const closeMatch = rest.match(closePattern);
      i = closeMatch ? gt + 1 + (closeMatch.index ?? 0) + closeMatch[0].length : len;
      continue;
    }

    if (!ALLOWED_TAGS.has(tagName)) {
      // 未列入白名单的标签：删除标签本身，保留其文字内容
      violations.push('已移除未允许的标签 <' + tagName + '>');
      i = gt + 1;
      continue;
    }

    if (isClosing) {
      emitCloseFor(tagName);
      i = gt + 1;
      continue;
    }

    // 解析属性
    const attrText = rawTag.slice(tagName.length);
    const attributes: string[] = [];
    const attrPattern = /([a-zA-Z-]+)\s*=\s*"([^"]*)"|([a-zA-Z-]+)\s*=\s*'([^']*)'|([a-zA-Z-]+)/g;
    let match: RegExpExecArray | null;
    while ((match = attrPattern.exec(attrText)) !== null) {
      const name = (match[1] ?? match[3] ?? match[5] ?? '').toLowerCase();
      const value = match[2] ?? match[4] ?? '';
      if (!name) continue;

      if (name.startsWith('on')) {
        violations.push('已移除事件处理器属性 ' + name);
        continue;
      }
      if (name === 'style') {
        const safeStyle = sanitizeStyle(value);
        if (safeStyle) attributes.push('style="' + escapeHtml(safeStyle) + '"');
        else violations.push('已移除不安全的行内样式');
        continue;
      }
      const allowed = ALLOWED_ATTRIBUTES[tagName];
      if (!allowed || !allowed.has(name)) continue;

      if (name === 'href') {
        if (DANGEROUS_URL_PROTOCOLS.test(value.trim())) {
          violations.push('已移除危险协议链接');
          continue;
        }
        if (!isSafeLinkUrl(value)) {
          violations.push('已移除非 HTTPS 外部链接');
          continue;
        }
        attributes.push('href="' + escapeHtml(value.trim()) + '"');
        continue;
      }
      if (name === 'src') {
        if (DANGEROUS_URL_PROTOCOLS.test(value.trim()) || !isSafeImageUrl(value)) {
          violations.push('已移除不安全的图片地址');
          continue;
        }
        attributes.push('src="' + escapeHtml(value.trim()) + '"');
        continue;
      }
      attributes.push(name + '="' + escapeHtml(value) + '"');
    }

    if (VOID_TAGS.has(tagName)) {
      out += '<' + tagName + (attributes.length > 0 ? ' ' + attributes.join(' ') : '') + ' />';
    } else {
      out += '<' + tagName + (attributes.length > 0 ? ' ' + attributes.join(' ') : '') + '>';
      stack.push(tagName);
    }
    i = gt + 1;
  }

  // 收尾未闭合标签
  while (stack.length > 0) {
    const open = stack.pop() as string;
    out += '</' + open + '>';
  }

  return { html: out, violations, hadViolations: violations.length > 0 };
}
