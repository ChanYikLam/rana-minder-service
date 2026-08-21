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
});
