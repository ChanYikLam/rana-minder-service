/**
 * 外部调用错误脱敏工具（adapters/redaction.ts；T3）。
 *
 * 权威依据：ADR-009 §2.9（超时、限流、重试、熔断、错误脱敏统一处理）、
 * OPS-CFG-005、接口契约-v1.0（ExternalError 不得含业务正文/密钥/令牌/完整响应）。
 *
 * 约束：
 * - 错误消息/落盘日志必须脱敏，不得包含密钥、令牌、完整外部响应或业务正文；
 * - 密码、令牌、连接串等一律不可逆遮蔽；URL 按最小披露折叠。
 */

/** 需强制遮蔽的子串（大小写不敏感）。 */
const SENSITIVE_SUBSTRINGS: readonly RegExp[] = [
  /(client[_-]?secret|access[_-]?key|secret[_-]?key|api[_-]?key|password|passwd|token|jwt|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi,
  /(?:^|[?&])(?:key|secret|token|password|signature|sig)=[^&\s]+/gi,
];

/** 遮蔽单个错误消息/字符串中的敏感子串。 */
export function redactMessage(input: string, maxLength = 400): string {
  let out = input;
  for (const re of SENSITIVE_SUBSTRINGS) {
    out = out.replace(re, (m, _p1) => {
      // 保留键名，遮蔽值：`client_secret=***`。
      const eq = m.indexOf('=');
      if (eq >= 0) {
        return `${m.slice(0, eq + 1)}***`;
      }
      const colon = m.indexOf(':');
      if (colon >= 0) {
        return `${m.slice(0, colon + 1)}***`;
      }
      return m.replace(/\S+/g, '***');
    });
  }
  // 折叠可能泄露路径/主机细节的 URL 查询参数已由上面覆盖；再统一截断。
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}

/** 是否包含疑似敏感内容（用于拒绝将原始响应写入错误）。 */
export function looksSensitive(input: string): boolean {
  return SENSITIVE_SUBSTRINGS.some((re) => {
    // 带 g 标志的正则 test() 会维护 lastIndex 状态，反复调用同一正则实例时
    // 结果不稳定（漏判敏感内容）。这里每次检测前重置 lastIndex，确保幂等。
    re.lastIndex = 0;
    return re.test(input);
  });
}

/** 从原始错误构造脱敏摘要（用于 ExternalError.message）。 */
export function toRedactedErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message;
    if (looksSensitive(msg)) {
      return 'external-error-redacted';
    }
    return redactMessage(msg);
  }
  if (typeof error === 'string') {
    return looksSensitive(error) ? 'external-error-redacted' : redactMessage(error);
  }
  return 'external-error';
}
