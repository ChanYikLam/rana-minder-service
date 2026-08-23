/**
 * 会话密钥派生（interfaces/nest；API-AUTH-001）。
 *
 * 会话 JWT 的本地签名密钥由 Casdoor clientSecret 的实际值派生。此派生规则必须在
 * 模块装配（签发方）与会话控制器（签发）之间保持一致——二者任一不同步都会
 * 导致签发的会话 JWT 无法被 OidcAuthSessionProvider 验证。故收敛为单一共享
 * 工具，消除两处重复实现。
 *
 * 安全要求（ADR-010）：调用方必须先 resolveSecret(clientSecretRef) 得到真实
 * 秘密后再传入，**禁止**直接传入未解析的引用串（如 ${env:...}）。引用串是
 * 仓库/配置里固定的公开常量，若直接以其派生，会话签名密钥对所有环境恒定且可
 * 离线推导，等同会话劫持（Critical）。
 */

import { createHash } from 'node:crypto';

/** 由 casdoor.clientSecret 的真实值派生会话签名密钥（HS256 32 字节）。 */
export function deriveSessionSecret(clientSecret: string): Uint8Array {
  return new TextEncoder().encode(
    createHash('sha256').update(`ranaminder-session:${clientSecret}`).digest('hex'),
  );
}
