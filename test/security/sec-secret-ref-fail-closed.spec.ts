/**
 * 安全控制独立验证：SEC-CTL-027（秘密只存引用；解析失败关闭；先解析后派生）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5、§15；
 * ADR-010（单文件外置配置）、ADR-010 §1.2（会话密钥必须以真实秘密派生）。
 *
 * 验证路径（真实代码，无 pg/jose 依赖）：
 * - src/config/secret-ref.ts
 * - src/modules/identity/interfaces/nest/session-secret.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SecretRefError, isSecretRef, resolveSecret } from '../../src/config/secret-ref';
import { deriveSessionSecret } from '../../src/modules/identity/interfaces/nest/session-secret';

const ENV_VAR = 'RANA_SEC_TEST_SECRET';
const REF = '${env:RANA_SEC_TEST_SECRET}';

describe('SEC-CTL-027 秘密引用解析失败关闭', () => {
  it('SEC-CTL-027：环境变量缺失时抛 SecretRefError，不回退默认值（fail-closed）', () => {
    const previous = process.env[ENV_VAR];
    delete process.env[ENV_VAR];
    try {
      assert.throws(() => resolveSecret(REF), (err: unknown) => {
        assert.ok(err instanceof SecretRefError);
        assert.match(err.message, /not set/);
        return true;
      });
    } finally {
      if (previous !== undefined) process.env[ENV_VAR] = previous;
    }
  });

  it('SEC-CTL-027：环境变量存在时返回真实值；非引用明文按开发期语义透传', () => {
    process.env[ENV_VAR] = 'real-secret-value';
    try {
      assert.equal(resolveSecret(REF), 'real-secret-value');
      assert.equal(resolveSecret('plain-dev-secret'), 'plain-dev-secret');
    } finally {
      delete process.env[ENV_VAR];
    }
  });

  it('SEC-CTL-027：未支持的引用形式（${vault:…}/${unknown:…}）一律报错不静默忽略', () => {
    for (const ref of ['${vault:kv/data/x}', '${unknown:x}', '${env}', '${file:}']) {
      assert.throws(() => resolveSecret(ref), SecretRefError, `ref=${ref}`);
    }
  });

  it('SEC-CTL-027：文件引用白名单外路径拒绝（防任意文件读取），白名单内不存在文件亦失败关闭', () => {
    assert.throws(
      () => resolveSecret('${file:/etc/passwd}'),
      (err: unknown) => {
        assert.ok(err instanceof SecretRefError);
        assert.match(err.message, /allowlist/);
        return true;
      },
    );
    assert.throws(() => resolveSecret('${file:./relative-secret}'), /allowlist/);
    assert.throws(() => resolveSecret('${file:/run/secrets/not-exists-secret}'), SecretRefError);
  });

  it('SEC-CTL-027：isSecretRef 只认 ${ 前缀引用形态', () => {
    assert.equal(isSecretRef(REF), true);
    assert.equal(isSecretRef('plain'), false);
    assert.equal(isSecretRef(42), false);
  });
});

describe('SEC-CTL-027 会话签名密钥先解析后派生', () => {
  it('SEC-CTL-027：直接以引用串派生的密钥 ≠ 以真实值派生的密钥（防恒定可离线推导密钥）', () => {
    const derivedFromRefLiteral = deriveSessionSecret(REF);
    const derivedFromRealValue = deriveSessionSecret('real-secret-value');
    assert.notDeepEqual(
      Buffer.from(derivedFromRefLiteral).toString('hex'),
      Buffer.from(derivedFromRealValue).toString('hex'),
    );
  });

  it('SEC-CTL-027：同明文派生恒定、异明文派生不同（SHA-256 十六进制摘要 64 字节）', () => {
    const a1 = deriveSessionSecret('alpha');
    const a2 = deriveSessionSecret('alpha');
    const b = deriveSessionSecret('beta');
    assert.deepEqual(Buffer.from(a1).toString('hex'), Buffer.from(a2).toString('hex'));
    assert.notDeepEqual(Buffer.from(a1).toString('hex'), Buffer.from(b).toString('hex'));
    assert.equal(Buffer.from(a1).byteLength, 64, 'sha256 hex 为 64 字符编码');
  });
});
