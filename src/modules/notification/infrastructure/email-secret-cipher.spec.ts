/**
 * 发信密钥加密测试（NTF-006：密钥不明文存储）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AesGcmEmailSecretCipher } from './email-secret-cipher';

describe('AesGcmEmailSecretCipher（NTF-006 密钥保护）', () => {
  const cipher = new AesGcmEmailSecretCipher();

  it('加密后不含明文；解密还原', () => {
    const plaintext = 'smtp-authorisation-code-123456';
    const ciphertext = cipher.encrypt(plaintext);
    assert.ok(!ciphertext.includes(plaintext), '密文不得包含明文');
    assert.equal(cipher.decrypt(ciphertext), plaintext);
  });

  it('相同明文每次加密产生不同密文（随机 IV）', () => {
    const a = cipher.encrypt('same-secret');
    const b = cipher.encrypt('same-secret');
    assert.notEqual(a, b);
    assert.equal(cipher.decrypt(a), 'same-secret');
    assert.equal(cipher.decrypt(b), 'same-secret');
  });

  it('密文被篡改时解密抛出异常（GCM 认证）', () => {
    const ciphertext = cipher.encrypt('tamper-me');
    const raw = Buffer.from(ciphertext, 'base64');
    raw[raw.length - 1] ^= 0xff;
    const tampered = raw.toString('base64');
    assert.throws(() => cipher.decrypt(tampered));
  });

  it('指纹稳定且不泄露明文', () => {
    const fp = cipher.fingerprint('my-secret');
    assert.equal(fp.length, 12);
    assert.equal(fp, cipher.fingerprint('my-secret'));
    assert.ok(!fp.includes('my-secret'));
    assert.notEqual(cipher.fingerprint('other'), fp);
  });

  it('非开发环境缺失 EMAIL_SECRET_CIPHER_KEY 时拒绝启动（fail-closed）', () => {
    const originalEnv = process.env.NODE_ENV;
    const originalKey = process.env.EMAIL_SECRET_CIPHER_KEY;
    try {
      delete process.env.EMAIL_SECRET_CIPHER_KEY;
      process.env.NODE_ENV = 'production';
      assert.throws(
        () => new AesGcmEmailSecretCipher(),
        /EMAIL_SECRET_CIPHER_KEY/,
        '生产环境缺失主密钥必须拒绝初始化',
      );
      process.env.NODE_ENV = 'staging';
      assert.throws(
        () => new AesGcmEmailSecretCipher(),
        /EMAIL_SECRET_CIPHER_KEY/,
        'staging 等非开发环境同样拒绝',
      );
    } finally {
      if (originalEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalEnv;
      if (originalKey === undefined) delete process.env.EMAIL_SECRET_CIPHER_KEY;
      else process.env.EMAIL_SECRET_CIPHER_KEY = originalKey;
    }
  });

  it('开发环境缺失主密钥时使用开发密钥（本地联调可用）', () => {
    const originalEnv = process.env.NODE_ENV;
    const originalKey = process.env.EMAIL_SECRET_CIPHER_KEY;
    try {
      delete process.env.EMAIL_SECRET_CIPHER_KEY;
      process.env.NODE_ENV = 'development';
      const devCipher = new AesGcmEmailSecretCipher();
      const plaintext = 'dev-only-secret';
      assert.equal(devCipher.decrypt(devCipher.encrypt(plaintext)), plaintext);
    } finally {
      if (originalEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalEnv;
      if (originalKey === undefined) delete process.env.EMAIL_SECRET_CIPHER_KEY;
      else process.env.EMAIL_SECRET_CIPHER_KEY = originalKey;
    }
  });
});
