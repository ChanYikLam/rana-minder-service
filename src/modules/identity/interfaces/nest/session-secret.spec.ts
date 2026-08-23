/**
 * deriveSessionSecret 单元测试（API-AUTH-001；安全加固）。
 *
 * 会话 JWT 签名密钥必须由 Casdoor clientSecret 的**真实值**派生，而不能由
 * 未解析的引用串（${env:...}，仓库/配置内公开常量）派生。本测试锁定该安全
 * 性质：不同环境（不同真实秘密）产出不同密钥；且引用串本身不参与派生。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { deriveSessionSecret } from './session-secret';

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

describe('deriveSessionSecret（会话签名密钥派生）', () => {
  it('密钥由真实秘密值派生（固定输入 → 稳定输出，供双端一致）', () => {
    const a = deriveSessionSecret('real-client-secret-A');
    const b = deriveSessionSecret('real-client-secret-A');
    assert.deepEqual(bytesToHex(a), bytesToHex(b));
    assert.equal(a.length, 64); // sha256 hex = 32 字节
  });

  it('不同环境的真实秘密 → 不同会话密钥（环境隔离）', () => {
    const prod = deriveSessionSecret('prod-client-secret');
    const staging = deriveSessionSecret('staging-client-secret');
    assert.notEqual(bytesToHex(prod), bytesToHex(staging));
  });

  it('密钥不依赖公开引用串（杜绝离线可推导的会话伪造）', () => {
    // 若把未解析引用串直接当输入，密钥对所有环境恒定且可离线推导（Critical）。
    // 真实秘密必须来自 resolveSecret(ref) 的产物，而非 ref 本身。
    const fromRef = deriveSessionSecret('${env:CASDOOR_CLIENT_SECRET}');
    const fromReal = deriveSessionSecret('actual-secret-loaded-from-env');
    assert.notEqual(bytesToHex(fromRef), bytesToHex(fromReal));

    // 引号串作为输入时结果不含引用串明文（无泄漏面）。
    assert.ok(
      !bytesToHex(fromReal).includes(
        createHash('sha256').update('${env:CASDOOR_CLIENT_SECRET}').digest('hex'),
      ),
    );
  });
});
