/**
 * 会话密钥派生（interfaces/nest；API-AUTH-001）。
 *
 * BUG-017 修复：支持专用会话密钥（SESSION_SECRET），避免复用 Casdoor
 * clientSecret 扩大攻击面。未配置专用密钥时回退到 clientSecret 派生（向后兼容）。
 *
 * 安全要求（ADR-010）：调用方必须先 resolveSecret 得到真实秘密后再传入，
 * **禁止**直接传入未解析的引用串。
 */

import { createHash } from 'node:crypto';

/**
 * 由会话签名密钥派生（HS256 32 字节）。
 *
 * @param clientSecret Casdoor clientSecret 真实值（回退派生源）
 * @param dedicatedSessionSecret 专用会话密钥（≥32 字符时优先使用；未配置则回退 v1 口径）
 */
export function deriveSessionSecret(
  clientSecret: string,
  dedicatedSessionSecret?: string,
): Uint8Array {
  if (dedicatedSessionSecret && dedicatedSessionSecret.length >= 32) {
    // v2：独立命名空间 + 专用密钥，与 clientSecret 完全解耦
    return new TextEncoder().encode(
      createHash('sha256').update(`ranaminder-session-v2:${dedicatedSessionSecret}`).digest('hex'),
    );
  }
  // v1 回退：从 clientSecret 派生（向后兼容保留）
  return legacyDeriveFromClientSecret(clientSecret);
}

/** v1 派生口径：由 casdoor.clientSecret 的真实值派生（向后兼容保留） */
function legacyDeriveFromClientSecret(clientSecret: string): Uint8Array {
  return new TextEncoder().encode(
    createHash('sha256').update(`ranaminder-session:${clientSecret}`).digest('hex'),
  );
}
