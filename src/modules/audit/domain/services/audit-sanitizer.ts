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
  'content',
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
        typeof value === 'string' ? value.length : value === null || value === undefined ? 0 : JSON.stringify(value)?.length ?? 0;
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
      if (s.redacted || typeof value === 'string' || value !== null) {
        diffs.push(`${key}=${s.display}`);
      }
    }
    return diffs.length > 0 ? diffs.join(';') : null;
  }
}
