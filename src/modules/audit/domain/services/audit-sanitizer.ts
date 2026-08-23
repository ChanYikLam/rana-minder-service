/**
 * 审计敏感字段脱敏器（AUD-003、CAS-SEC-001~004）。
 *
 * **敏感不落盘**：密码、邮箱密钥、令牌、验证码、附件正文不得进审计；
 * 敏感字段只记脱敏差异（如 `password: <REDACTED>`、`token: redacted:<len>`）。
 */
/** 敏感字段词（归一化后匹配；覆盖驼峰/下划线/中划线变体） */
const SENSITIVE_FIELD_WORDS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'smtpsecret',
  'emailsecret',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'token',
  'verifycode',
  'captcha',
  'attachmentbody',
];

/** 归一化字段名（去分隔符转小写；smtpSecret → smtpsecret） */
const normalizeField = (name: string): string => name.replace(/[^a-z0-9]/gi, '').toLowerCase();

/** 递归下钻的最大深度：防止攻击者可控的深嵌套输入导致递归栈溢出（RangeError） */
const MAX_SANITIZE_DEPTH = 100;

// ---------- 自由文本内联凭证脱敏正则（redactInlineCredentials 共用） ----------
// 敏感前缀可组合成 access_token / client-secret / api.key 等复合敏感键；
// 分隔符支持 下划线 / 连字符 / 点号，避免 access-token、api.token 等变体绕过。
const SENSITIVE_PREFIX_SRC =
  '(?:access|refresh|auth|client|smtp|email|api|secret|session|activation|reset|jwt|bearer|verify|verification|private|public|user|login)';
// 独立出现即敏感的字段词（无需前缀）：token/secret/password 等真凭证词
const STANDALONE_SENSITIVE_SRC = '(?:token|secret|password|passwd|apikey|credential)';
// 仅带敏感前缀才敏感的字段词（key/code 独立出现多为普通排查信息，避免过度脱敏）
const PREFIXED_SENSITIVE_SRC = '(?:key|code)';
// 敏感键名整体：(前缀[分隔符]基础词) 或 (独立敏感词)
const SENSITIVE_NAME_SRC = `(?:${SENSITIVE_PREFIX_SRC}[_.-]?(?:${STANDALONE_SENSITIVE_SRC}|${PREFIXED_SENSITIVE_SRC})|${STANDALONE_SENSITIVE_SRC})`;
// 敏感值：无引号 / 单引号 / 双引号三类形态（防引号包裹导致提前截断漏脱敏）
const SENSITIVE_VALUE_SRC = `(?:"[^"]*"|'[^']*'|[^&;\\s,"':]+)`;
// JSON 键值对里的敏感值
const JSON_VALUE_SRC = `(?:"[^"]*"|'[^']*'|[^,}\\s]+)`;
// key=value / key:value 自由文本形态
const INLINE_KEY_VALUE_RE = new RegExp(
  `(^|[&;\\s,"':])(${SENSITIVE_NAME_SRC})\\b\\s*[=:]\\s*(${SENSITIVE_VALUE_SRC})`,
  'gi',
);
// JSON 键值对形态：{"password":"abc"} / {"access_token": "tok"}
const INLINE_JSON_RE = new RegExp(`("${SENSITIVE_NAME_SRC}"\\s*:\\s*)(${JSON_VALUE_SRC})`, 'gi');

/** 是否属于敏感字段名（含复数词干匹配：tokens→token、secrets→secret 等） */
const isSensitiveField = (name: string): boolean => {
  const norm = normalizeField(name);
  if (SENSITIVE_FIELD_WORDS.includes(norm)) {
    return true;
  }
  // 复数词干：去尾 s 后再匹配，覆盖 tokens/secrets/passwords 等复数形式；
  // 长度>1 防单字符误判，仅去单个尾 s 避免 address/status 等被误伤。
  return norm.length > 1 && norm.endsWith('s') && SENSITIVE_FIELD_WORDS.includes(norm.slice(0, -1));
};

/** 脱敏结果 */
export interface SanitizedAuditValue {
  /** 脱敏后的展示值（不含敏感正文） */
  readonly display: string;
  /** 是否检测到敏感字段（只记差异） */
  readonly redacted: boolean;
}

/**
 * 审计脱敏器（纯规则）。
 */
export class AuditSanitizer {
  /** 字段级脱敏：敏感字段只记差异，不落正文（CAS-SEC-001~004） */
  sanitizeField(fieldName: string, value: unknown): SanitizedAuditValue {
    if (isSensitiveField(fieldName)) {
      const len = this.sensitiveValueLength(value);
      return { display: `<REDACTED:${len}>`, redacted: true };
    }
    if (value === null || value === undefined) {
      return { display: '', redacted: false };
    }
    if (typeof value === 'string') {
      // 长文本（可能为附件正文/内容）截断并标记
      if (value.length > 256) {
        return { display: `${value.slice(0, 32)}…(truncated:${value.length})`, redacted: false };
      }
      return { display: value, redacted: false };
    }
    const json = this.safeJsonStringify(value);
    if (json === null) {
      return { display: '<unserializable>', redacted: false };
    }
    return { display: json, redacted: false };
  }

  /** 敏感值长度估算（不落正文；对不可序列化/循环引用不抛错） */
  private sensitiveValueLength(value: unknown): number {
    if (typeof value === 'string') {
      return value.length;
    }
    if (value === null || value === undefined) {
      return 0;
    }
    const json = this.safeJsonStringify(value);
    return json === null ? 0 : json.length;
  }

  /** 安全 JSON 序列化（循环引用/序列化异常返回 null，不抛错） */
  private safeJsonStringify(value: unknown): string | null {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }

  /** 全对象脱敏（只保留脱敏差异；用于旧值/新值落盘；返回脱敏后的差异字符串，无差异则 null） */
  sanitizeObject(input: Record<string, unknown> | null | undefined): string | null {
    if (input === null || input === undefined) {
      return null;
    }
    const diffs: string[] = [];
    const stack = new Set<object>();
    try {
      this.collectDiffs(input, '', diffs, stack, 0);
    } catch {
      // 兜底：任何意外异常（如深嵌套栈溢出）都不应让审计写入抛裸异常、拖垮业务；
      // 改为记录一个不可序列化的占位差异，保证审计可写入且不泄漏内部细节。
      return '<unserializable:depth-limit>';
    }
    return diffs.length > 0 ? diffs.join(';') : null;
  }

  /** 特殊对象容器（Date/Map/Set 等）：不递归展开，直接序列化为叶子 */
  private isSpecialContainer(child: unknown): boolean {
    if (typeof child !== 'object' || child === null || Array.isArray(child)) {
      return false;
    }
    const tag = Object.prototype.toString.call(child);
    // Date/RegExp/Buffer 等标量容器：内部无业务敏感键，直接序列化即可
    return (
      child instanceof Date ||
      child instanceof RegExp ||
      child instanceof Map ||
      child instanceof Set ||
      child instanceof ArrayBuffer ||
      (typeof Buffer !== 'undefined' && Buffer.isBuffer(child)) ||
      /^\[object (Date|RegExp|Map|Set|ArrayBuffer|Uint8Array)\]$/.test(tag)
    );
  }

  /** 是否为可递归展开的对象（排除 Date/Map 等特殊容器，避免误展开；含 class 实例） */
  private isPlainRecord(child: unknown): child is Record<string, unknown> {
    return (
      typeof child === 'object' &&
      child !== null &&
      !Array.isArray(child) &&
      !this.isSpecialContainer(child)
    );
  }

  /** 递归收集脱敏差异（敏感字段名任意层级均脱敏；非敏感叶子为空值不记录） */
  private collectDiffs(
    value: Record<string, unknown> | unknown[],
    prefix: string,
    diffs: string[],
    stack: Set<object>,
    depth: number,
  ): void {
    // 真正的循环引用（出现在当前祖先链上）才跳过，防止无限递归、不把循环体正文落盘；
    // 共享引用（同一对象被多处引用但非循环）应正常下钻，避免遗漏差异。
    if (stack.has(value)) {
      return;
    }
    // 超过最大深度：不再继续递归，标记占位，防深嵌套对象导致递归栈溢出，
    // 也不把超限部分整体序列化（其中可能含敏感字段明文）。
    if (depth > MAX_SANITIZE_DEPTH) {
      diffs.push(`${prefix || 'value'}=<depth-limit>`);
      return;
    }
    stack.add(value);
    try {
      const entries: ReadonlyArray<readonly [string, unknown]> = Array.isArray(value)
        ? value.map((v, i) => [`${prefix}[${i}]`, v] as const)
        : Object.entries(value).map(([k, v]) => [`${prefix ? `${prefix}.` : ''}${k}`, v] as const);

      for (const [path, child] of entries) {
        // 剥离数组下标（如 tokens[0] → tokens）后再判断是否敏感，
        // 否则 tokens[0] 归一化为 tokens0 无法命中敏感词表，导致敏感值明文落盘。
        const leafName = path.slice(path.lastIndexOf('.') + 1).replace(/\[\d+\]/g, '');
        if (isSensitiveField(leafName)) {
          const s = this.sanitizeField(leafName, child);
          diffs.push(`${path}=${s.display}`);
          continue;
        }
        if (Array.isArray(child)) {
          this.collectDiffs(child, path, diffs, stack, depth + 1);
          continue;
        }
        if (this.isPlainRecord(child)) {
          this.collectDiffs(child, path, diffs, stack, depth + 1);
          continue;
        }
        if (child !== undefined && child !== null) {
          const s = this.sanitizeField(
            leafName,
            typeof child === 'string' ? this.redactInlineCredentials(child) : child,
          );
          diffs.push(`${path}=${s.display}`);
        }
      }
    } finally {
      stack.delete(value);
    }
  }

  /**
   * 自由文本（如失败原因）脱敏：截断超长文本，并抹掉常见的 `key=value` 敏感键值
   * 与 URL 查询串中的凭证，防止错误信息把令牌/密码/密钥带进审计（AUD-003 敏感不落盘）。
   */
  sanitizeMessage(message: string | null | undefined): string | undefined {
    if (message === null || message === undefined) {
      return undefined;
    }
    let text = this.redactInlineCredentials(message);
    if (text.length > 256) {
      text = `${text.slice(0, 256)}…(truncated:${message.length})`;
    }
    return text;
  }

  /**
   * 抹掉自由文本内嵌的敏感键值/认证头/会话值/URL 凭证（不截断）。
   * 供 sanitizeMessage 与 sanitizeObject 的字符串叶子共用，防止普通字段值
   * 内嵌 `password=..`/`token=..` 等凭证被带进审计。
   */
  private redactInlineCredentials(input: string): string {
    let text = input;
    // 敏感值可能是无引号、单引号或双引号包裹（如 token="abc"、password: 'pw'），
    // 若只用 [^...]+ 会因遇到引号提前截断而漏脱敏，导致凭证正文泄漏，故统一支持三类形态。
    // key=value / key:value 自由文本形态：
    // - 复合键分隔符支持 下划线/连字符/点号（access_token / access-token / api.token）；
    // - 独立词 key/code 不再作为敏感词（key=1、code=404 属正常排查信息，避免过度脱敏），
    //   仅当由敏感前缀组成复合键（api_key、verify_code、client_secret 等）时才脱敏。
    text = text.replace(
      INLINE_KEY_VALUE_RE,
      (_m, sep: string, name: string) => `${sep}${name}=<REDACTED>`,
    );
    // JSON 键值对形态：{"password":"abc"}、{"access_token": "tok"}
    text = text.replace(INLINE_JSON_RE, '$1<REDACTED>');
    // 抹掉 Authorization 认证头里的凭证正文（Bearer/Basic/Digest token，含引号包裹）
    text = text.replace(
      /([a-z-]*authorization)\s*:\s*(?:bearer|basic|digest|token)?\s*(?:"[^"]*"|'[^']*'|[^\s,;，。：:"]+)/gi,
      (_m, header: string) => `${header}: <REDACTED>`,
    );
    // 抹掉 Cookie / Set-Cookie 里的会话凭证值（含引号包裹）
    text = text.replace(
      /(cookie|set-cookie)\s*:\s*(?:"[^"]*"|'[^']*'|[^\s,;，。：:"]+)/gi,
      '$1: <REDACTED>',
    );
    // 抹掉 URL 查询串里的凭证参数（含引号包裹；key/code 同样仅复合前缀才脱敏，防过度脱敏）
    text = text.replace(
      new RegExp(`([?&])${SENSITIVE_NAME_SRC}=(?:"[^"]*"|'[^']*'|[^&\\s]*)`, 'gi'),
      '$1<REDACTED>',
    );
    return text;
  }
}
