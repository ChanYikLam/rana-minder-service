/**
 * 本地会话 JWT 签名密钥解析（interfaces/nest；CAS-AUTH-001）。
 *
 * 安全要求：签名密钥必须是高熵、不可预测的（否则本地会话令牌可被伪造/提权）。
 *
 * 解析优先级（ADR-010 外置秘密引用）：
 *   1. casdoor.sessionSecretRef 配置（独立随机高熵密钥，推荐）——解析后直接作为密钥；
 *   2. 未配置时回退到解析后的 Casdoor clientSecret（生产为 Casdoor 随机生成的高熵
 *      密钥，HMAC 派生）。**禁止**从 clientSecretRef 引用串派生——引用串（如
 *      ${env:CASDOOR_CLIENT_SECRET}）是低熵、可被猜测的，用作签名密钥可导致
 *      本地会话令牌被伪造。
 */

import { createHash } from 'node:crypto';
import { isSecretRef, resolveSecret } from '../../../../config';
import type { CasdoorConfig } from '../../../../config';

/**
 * 解析本地会话签名密钥（Uint8Array，供 jose HS256 使用）。
 * @param casdoor Casdoor 配置
 * @param logWarning 可选回调，用于在回退到 clientSecret 派生时记录提示（避免日志泄漏）
 */
export function resolveSessionSecret(
  casdoor: CasdoorConfig,
  logWarning?: (message: string) => void,
): Uint8Array {
  if (casdoor.sessionSecretRef) {
    const secret = isSecretRef(casdoor.sessionSecretRef)
      ? resolveSecret(casdoor.sessionSecretRef)
      : casdoor.sessionSecretRef;
    return new TextEncoder().encode(secret);
  }
  logWarning?.(
    'CAS-AUTH-001: 未配置 casdoor.sessionSecretRef，会话签名密钥回退到 Casdoor clientSecret 派生（建议配置独立随机高熵密钥）',
  );
  // 从解析后的真实 clientSecret（高熵）派生，而非 clientSecretRef 引用串。
  const clientSecret = isSecretRef(casdoor.clientSecretRef)
    ? resolveSecret(casdoor.clientSecretRef)
    : casdoor.clientSecretRef;
  return new TextEncoder().encode(
    createHash('sha256').update(`ranaminder-session:${clientSecret}`).digest('hex'),
  );
}
