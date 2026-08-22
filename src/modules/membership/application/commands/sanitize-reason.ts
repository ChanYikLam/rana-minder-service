/**
 * 对 Casdoor 返回的技术原因做基础脱敏（落库前调用）。
 * 与邀请模块 resolve-activation 同一入口语义：先整段抹除"敏感键=值"对，
 * 再兜底遮蔽裸敏感关键词；限制长度避免异常堆栈膨胀历史。
 */
export function sanitizeReason(reason: string): string {
  // 整对抹除：token=xxx / secret: xxx / password="xxx" 等键值形态
  const SENSITIVE_PAIR =
    /((?:token|secret|password|passwd|credential|authorization)\s*[=:]\s*"?)((?:"(?:[^"]*)")|(?:[^"&\s]+))/gi;
  const SENSITIVE_KEYWORD =
    /(token|secret|password|passwd|credential|authorization|bearer\s+\S+)/gi;
  const clipped = reason.length > 200 ? reason.slice(0, 200) + '…' : reason;
  return clipped.replace(SENSITIVE_PAIR, '$1[redacted]').replace(SENSITIVE_KEYWORD, '[redacted]');
}
