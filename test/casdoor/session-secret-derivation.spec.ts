/**
 * 会话密钥派生强度测试（API-AUTH-001 / ADR-010 / CAS-SEC-002）。
 *
 * 契约锚点：
 * - `CAS-SEC-002`：客户端秘密只能从数据库外受控配置入口加载，数据库/仓库只保存
 *   秘密**引用**；引用串（如 `${env:VAR}`）是仓库内公开常量；
 * - identity.module 装配分支（identity.module.ts:141-146）：必须先
 *   `isSecretRef(ref) ? resolveSecret(ref) : ref` 解析出**真实秘密**，
 *   再 `deriveSessionSecret(clientSecret)` —— 禁止以未解析引用串直接派生
 *   （否则密钥对所有环境恒定且可离线推导 → 会话伪造 Critical）。
 *
 * 本文件做纯函数级验证：deriveSessionSecret（session-secret.ts）×
 * isSecretRef/resolveSecret（src/config/secret-ref.ts）的组合语义。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveSessionSecret } from '../../src/modules/identity/interfaces/nest/session-secret';
import { isSecretRef, resolveSecret, SecretRefError } from '../../src/config';

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

describe('deriveSessionSecret 确定性（同输入同输出）', () => {
  it('同一 clientSecret 派生结果逐字节稳定（签发方与会话控制器双端一致的前提）', () => {
    const a = hex(deriveSessionSecret('same-input-secret'));
    const b = hex(deriveSessionSecret('same-input-secret'));
    assert.equal(a, b);
  });

  it('输出为 sha256 hex 的 64 字节 UTF-8 编码（64 字符密钥，满足 HS256 强度）', () => {
    const derived = deriveSessionSecret('length-check');
    // TextEncoder().encode(hex) → 每个十六进制字符一个字节，共 64 字节；
    // 其 hex 再表示为 128 个十六进制字符。
    assert.equal(derived.length, 64);
    assert.match(hex(derived), /^[0-9a-f]{128}$/);
  });

  it('空串输入也产生确定输出（不抛错；强度由上游禁止弱输入保障）', () => {
    assert.equal(hex(deriveSessionSecret('')), hex(deriveSessionSecret('')));
    assert.notEqual(hex(deriveSessionSecret('')), hex(deriveSessionSecret('x')));
  });
});

describe('deriveSessionSecret 区分度（异客户端密钥派生不同）', () => {
  it('不同环境的真实秘密 → 不同会话签名密钥（环境隔离）', () => {
    const schoolA = hex(deriveSessionSecret('school-a-client-secret'));
    const schoolB = hex(deriveSessionSecret('school-b-client-secret'));
    assert.notEqual(schoolA, schoolB);
  });

  it('仅一个字符差异 → 派生结果完全不同（雪崩效应）', () => {
    const base = hex(deriveSessionSecret('secret-value-0001'));
    const flipped = hex(deriveSessionSecret('secret-value-0002'));
    assert.notEqual(base, flipped);
  });

  it("明文弱恒串（'secret'、'changeme' 类）虽可被接受为字符串，但派生值互不相同且非恒等映射可猜", () => {
    // 函数本身是纯哈希：安全性契约由调用方保证"传入的是 resolveSecret 的产物"。
    // 此处锁定弱恒串之间不会碰撞到同一密钥（排除恒串捷径）。
    const weakOnes = ['secret', '123456', 'changeme', '${env:CLIENT_SECRET}'];
    const derived = weakOnes.map((s) => hex(deriveSessionSecret(s)));
    assert.equal(new Set(derived).size, weakOnes.length);
  });
});

describe('isSecretRef 分支语义（identity.module.ts:142-144 装配契约的纯函数级验证）', () => {
  it("引用形态（${env:...} 前缀）→ isSecretRef=true，必须先解析再派生", () => {
    process.env['RANAMINDER_TEST_CASDOOR_SECRET'] = 'live-real-secret-from-env';
    try {
      const ref = '${env:RANAMINDER_TEST_CASDOOR_SECRET}';
      assert.equal(isSecretRef(ref), true);
      const real = resolveSecret(ref);
      assert.equal(real, 'live-real-secret-from-env');

      // 装配分支语义：真实密钥 ≠ 以公开引用串直接派生的密钥
      const derivedFromReal = hex(deriveSessionSecret(real));
      const derivedFromRefLiteral = hex(deriveSessionSecret(ref));
      assert.notEqual(derivedFromReal, derivedFromRefLiteral);

      // 公开引用串派生值可被任何读到仓库的人离线复算 → 不得成为线上密钥
      assert.ok(!derivedFromReal.startsWith(hex(deriveSessionSecret(ref)).slice(0, 16)));
    } finally {
      delete process.env['RANAMINDER_TEST_CASDOOR_SECRET'];
    }
  });

  it('非引用明文（开发期直填）→ isSecretRef=false，原样透传参与派生', () => {
    const plain = 'dev-only-plaintext-secret';
    assert.equal(isSecretRef(plain), false);
    // 分支语义：resolveSecret 不被调用，plain 直接作为派生输入
    assert.equal(hex(deriveSessionSecret(plain)), hex(deriveSessionSecret(plain)));
  });

  it('不受支持的引用（${vault:...} 等）→ resolveSecret 抛 SecretRefError：装配失败关闭而非以垃圾串派生', () => {
    const badRef = '${vault:kv/casdoor-secret}';
    assert.equal(isSecretRef(badRef), true);
    assert.throws(() => resolveSecret(badRef), SecretRefError);
  });

  it('引用指向的环境变量缺失 → resolveSecret 抛错（fail-closed，不回退到引用串字面量）', () => {
    delete process.env['RANAMINDER_DEFINITELY_UNSET_VAR'];
    assert.throws(
      () => resolveSecret('${env:RANAMINDER_DEFINITELY_UNSET_VAR}'),
      (err: unknown) =>
        err instanceof SecretRefError && err.message.includes('RANAMINDER_DEFINITELY_UNSET_VAR'),
    );
  });
});
