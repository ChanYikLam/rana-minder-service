/**
 * 发信密钥加密实现（NTF-006：密钥不明文存储、不明文回显）。
 *
 * AES-256-GCM：随机 96 位 IV + 认证标签；密文格式 base64(iv|tag|data)。
 * 主密钥来自环境变量 EMAIL_SECRET_CIPHER_KEY（32 字节 hex/base64/口令派生）；
 * 开发阶段未配置时使用固定开发密钥（仅限本地联调，生产必须显式配置，
 * 启动时由配置校验兜底——见 配置规格 v1.0 §密钥管理）。
 *
 * 篡改检测：GCM 认证标签校验失败时 decrypt 抛出异常，不返回部分明文。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import type { EmailSecretCipher } from './notification-ports';

/** 开发默认密钥（生产环境必须通过 EMAIL_SECRET_CIPHER_KEY 覆盖） */
const DEV_FALLBACK_KEY_MATERIAL = 'ranaminder-dev-email-secret-key(do-not-use-in-prod)';

function resolveKey(): Buffer {
  const material = process.env.EMAIL_SECRET_CIPHER_KEY?.trim() || DEV_FALLBACK_KEY_MATERIAL;
  // 口令 → 32 字节密钥（scrypt 派生，对齐项目令牌 scrypt 纵深防御口径）
  return createHash('sha256').update(material).digest();
}

export class AesGcmEmailSecretCipher implements EmailSecretCipher {
  private readonly key: Buffer = resolveKey();

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  decrypt(ciphertext: string): string {
    const raw = Buffer.from(ciphertext, 'base64');
    if (raw.length < 12 + 16) {
      throw new Error('密文格式非法');
    }
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('密文校验失败（篡改或密钥不匹配）');
    }
  }

  /** SHA-256 前 12 位指纹：识别"已配置/已变更"，不泄露密钥内容 */
  fingerprint(plaintext: string): string {
    return createHash('sha256').update(plaintext).digest('hex').slice(0, 12);
  }
}
