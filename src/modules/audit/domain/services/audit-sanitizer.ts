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

/** 是否属于敏感字段名 */
const isSensitiveField = (name: string): boolean =>
  SENSITIVE_FIELD_WORDS.includes(normalizeField(name));

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
    const seen = new WeakSet<object>();
    this.collectDiffs(input, '', diffs, seen);
    return diffs.length > 0 ? diffs.join(';') : null;
  }

  /** 是否为可递归展开的普通对象（排除 Date/Map 等特殊对象，避免误展开） */
  private isPlainRecord(child: unknown): child is Record<string, unknown> {
    return (
      typeof child === 'object' &&
      child !== null &&
      !Array.isArray(child) &&
      Object.getPrototypeOf(child) === Object.prototype
    );
  }

  /** 递归收集脱敏差异（敏感字段名任意层级均脱敏；非敏感叶子为空值不记录） */
  private collectDiffs(
    value: Record<string, unknown> | unknown[],
    prefix: string,
    diffs: string[],
    seen: WeakSet<object>,
  ): void {
    // 防循环引用导致的无限递归：已访问对象不再下钻（不会把循环体正文落盘）
    if (seen.has(value)) {
      return;
    }
    seen.add(value);
    const entries: ReadonlyArray<readonly [string, unknown]> = Array.isArray(value)
      ? value.map((v, i) => [`${prefix}[${i}]`, v] as const)
      : Object.entries(value).map(([k, v]) => [`${prefix ? `${prefix}.` : ''}${k}`, v] as const);

    for (const [path, child] of entries) {
      const leafName = path.slice(path.lastIndexOf('.') + 1);
      if (isSensitiveField(leafName)) {
        const s = this.sanitizeField(leafName, child);
        diffs.push(`${path}=${s.display}`);
        continue;
      }
      if (Array.isArray(child)) {
        this.collectDiffs(child, path, diffs, seen);
        continue;
      }
      if (this.isPlainRecord(child)) {
        this.collectDiffs(child, path, diffs, seen);
        continue;
      }
      if (child !== undefined && child !== null) {
        const s = this.sanitizeField(leafName, child);
        diffs.push(`${path}=${s.display}`);
      }
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
    let text = message;
    // 抹掉 key=value / key:value 形式的敏感键值（覆盖 token/secret/password/key/code 等）。
    // 键前须有分隔符（&、;、空白、引号、冒号或字符串起始），避免误伤普通文本，
    // 同时保证凭证出现在字符串起始处时也能被抹掉，防止敏感信息落盘。
    text = text.replace(
      /(^|[&;\s,"':])([a-z0-9_-]{0,40}(?:token|secret|password|passwd|apikey|key|code|credential))\s*[=:]\s*[^&;\s,"':]+/gi,
      (_m, sep: string, name: string) => `${sep}${name}=<REDACTED>`,
    );
    // 抹掉 URL 查询串里的凭证参数
    text = text.replace(
      /([?&])(?:token|access_token|secret|password|key|code|verifycode)=[^&\s]*/gi,
      '$1<REDACTED>',
    );
    if (text.length > 256) {
      text = `${text.slice(0, 256)}…(truncated:${message.length})`;
    }
    return text;
  }
}
