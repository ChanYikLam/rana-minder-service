/**
 * resolveSessionSecret 单元测试（CAS-AUTH-001）。
 * 安全不变量：
 * - 从独立 sessionSecretRef 解析出的密钥 ≠ 从 clientSecret 派生的密钥（独立、不耦合）；
 * - 低熵引用串（${env:...}）绝不能被当作密钥：配置了独立密钥时不回退到 clientSecret；
 * - 未配置独立密钥时从解析后的真实 clientSecret 派生（高熵），而非引用串。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSessionSecret } from './session-secret';
import type { CasdoorConfig } from '../../../../config';

function decode(secret: Uint8Array): string {
  return new TextDecoder().decode(secret);
}

function baseConfig(overrides: Partial<CasdoorConfig> = {}): CasdoorConfig {
  return {
    endpoint: 'https://casdoor.example.edu',
    clientId: 'myclient',
    organization: 'myorg',
    redirectUri: 'http://localhost:3000/api/auth/callback',
    clientSecretRef: 'plaintext-client-secret-0123456789abcdef',
    sessionSecretRef: '',
    ...overrides,
  };
}

describe('resolveSessionSecret（CAS-AUTH-001）', () => {
  it('配置独立 sessionSecretRef（明文）时直接作为密钥（不回退 clientSecret）', () => {
    const secret = resolveSessionSecret(baseConfig({ sessionSecretRef: 'independent-rand-key' }));
    assert.equal(decode(secret), 'independent-rand-key');
  });

  it('配置 ${env:...} 引用时解析环境变量得到密钥', () => {
    const original = process.env['CASDOOR_SESSION_SECRET'];
    process.env['CASDOOR_SESSION_SECRET'] = 'env-resolved-high-entropy-key';
    try {
      const secret = resolveSessionSecret(
        baseConfig({ sessionSecretRef: '${env:CASDOOR_SESSION_SECRET}' }),
      );
      assert.equal(decode(secret), 'env-resolved-high-entropy-key');
    } finally {
      if (original === undefined) delete process.env['CASDOOR_SESSION_SECRET'];
      else process.env['CASDOOR_SESSION_SECRET'] = original;
    }
  });

  it('独立密钥与 clientSecret 派生密钥不同（不耦合）', () => {
    const independent = decode(resolveSessionSecret(baseConfig({ sessionSecretRef: 'indep-key' })));
    const derived = decode(resolveSessionSecret(baseConfig()));
    assert.notEqual(independent, derived);
  });

  it('未配置独立密钥时从解析后的 clientSecret 派生（非引用串）', () => {
    // clientSecretRef 为引用串，解析后应为真实 clientSecret；派生结果不得包含引用串。
    const original = process.env['CASDOOR_CLIENT_SECRET'];
    process.env['CASDOOR_CLIENT_SECRET'] = 'real-client-secret-abcdef';
    try {
      const secret = decode(
        resolveSessionSecret(baseConfig({ clientSecretRef: '${env:CASDOOR_CLIENT_SECRET}' })),
      );
      assert.ok(secret.length > 0);
      assert.ok(!secret.includes('${env:'));
      assert.ok(!secret.includes('CASDOOR_CLIENT_SECRET'));
    } finally {
      if (original === undefined) delete process.env['CASDOOR_CLIENT_SECRET'];
      else process.env['CASDOOR_CLIENT_SECRET'] = original;
    }
  });

  it('未配置独立密钥时回退并发出 warning 日志', () => {
    let warned = false;
    resolveSessionSecret(baseConfig(), () => {
      warned = true;
    });
    assert.equal(warned, true);
  });
});
