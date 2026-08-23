/**
 * 会话安全共享工具（interfaces/nest；API-AUTH-001、ADR-010）。
 *
 * 单点化两处职责，避免 controller 与 identity.module 派生逻辑漂移不一致：
 * - resolveCasdoorClientSecret：把 casdoor.clientSecretRef 从 ADR-010 秘密引用
 *   （${env:...}/${file:...}）解析为真实明文；非引用串视为开发期明文直接使用
 *   （与 adapters.module 的 DB/Casdoor 处理保持一致的最小披露）。
 * - deriveSessionSecret：从已解析的客户端秘密派生本地会话 HMAC 密钥。派生基于
 *   解析后的真实秘密，杜绝把引用串当密钥导致的低熵可预测问题（CAS-CAP-006）。
 */

import { createHash } from 'node:crypto';
import { isSecretRef, resolveSecret } from '../../../../config';

/** 解析 Casdoor 客户端秘密引用为明文（ADR-010 最小披露）。 */
export function resolveCasdoorClientSecret(clientSecretRef: string): string {
  return isSecretRef(clientSecretRef) ? resolveSecret(clientSecretRef) : clientSecretRef;
}

/** 从已解析的客户端秘密派生会话 HMAC 密钥（HS256 本地签发）。 */
export function deriveSessionSecret(clientSecret: string): Uint8Array {
  return new TextEncoder().encode(
    createHash('sha256').update(`ranaminder-session:${clientSecret}`).digest('hex'),
  );
}
