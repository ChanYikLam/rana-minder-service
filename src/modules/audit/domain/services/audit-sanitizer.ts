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
    if (SENSITIVE_FIELD_WORDS.includes(normalizeField(fieldName))) {
      const len =
        typeof value === 'string'
          ? value.length
          : value === null || value === undefined
            ? 0
            : (JSON.stringify(value)?.length ?? 0);
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
    try {
      return { display: JSON.stringify(value), redacted: false };
    } catch {
      return { display: '<unserializable>', redacted: false };
    }
  }

  /** 全对象脱敏（只保留脱敏差异；用于旧值/新值落盘；返回脱敏后的差异字符串，无差异则 null） */
  sanitizeObject(input: Record<string, unknown> | null | undefined): string | null {
    if (input === null || input === undefined) {
      return null;
    }
    const diffs: string[] = [];
    for (const [key, value] of Object.entries(input)) {
      const s = this.sanitizeField(key, value);
      // 过滤掉 undefined/null：不记录无意义的空值差异；字符串（含空串）与
      // 其它非空值（数字/布尔/对象）以及已脱敏的敏感字段才记录
      if (s.redacted || (value !== undefined && value !== null)) {
        diffs.push(`${key}=${s.display}`);
      }
    }
    return diffs.length > 0 ? diffs.join(';') : null;
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
    // 抹掉 key=value / key:value 形式的敏感键值（覆盖 token/secret/password/key/code 等）
    text = text.replace(
      /([&;\s,"'])([a-z0-9_-]{0,40}(?:token|secret|password|passwd|apikey|key|code|credential))\s*[=:]\s*[^&;\s,"']+/gi,
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
