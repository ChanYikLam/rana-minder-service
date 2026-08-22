/**
 * 对 Casdoor 返回的技术原因做基础脱敏（落库前调用）。
 * 与邀请模块 resolve-activation 同一规则：过滤敏感字段、限制长度。
 */
export function sanitizeReason(reason: string): string {
  const SENSITIVE = /(token|secret|password|passwd|credential|authorization|bearer\s+\S+)/gi;
  const clipped = reason.length > 200 ? reason.slice(0, 200) + '…' : reason;
  return clipped.replace(SENSITIVE, '[redacted]');
}
