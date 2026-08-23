/**
 * 会话密钥派生（interfaces/nest；API-AUTH-001）。
 *
 * 会话 JWT 的本地签名密钥由 Casdoor clientSecretRef 派生。此派生规则必须在
 * 模块装配（签发方）与会话控制器（签发）之间保持一致——二者任一不同步都会
 * 导致签发的会话 JWT 无法被 OidcAuthSessionProvider 验证。故收敛为单一共享
 * 工具，消除两处重复实现。
 */

import { createHash } from 'node:crypto';

/** 由 casdoor.clientSecretRef 派生会话签名密钥（HS256 32 字节）。 */
export function deriveSessionSecret(clientSecretRef: string): Uint8Array {
  return new TextEncoder().encode(
    createHash('sha256').update(`ranaminder-session:${clientSecretRef}`).digest('hex'),
  );
}
