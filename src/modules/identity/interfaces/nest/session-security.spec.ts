/**
 * session-security 共享工具单元测试：
 * - resolveCasdoorClientSecret：引用串解析为环境变量明文，明文直接透传（ADR-010）；
 * - deriveSessionSecret：同一明文派生稳定密钥，不同明文派生不同密钥（单点化一致性）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCasdoorClientSecret, deriveSessionSecret } from './session-security';

describe('session-security（单点化密钥派生）', () => {
  it('resolveCasdoorClientSecret：${env:...} 引用解析为环境变量明文', () => {
    process.env.TEST_CASDOOR_SECRET = 'env-secret-value';
    const ref = '${env:TEST_CASDOOR_SECRET}';
    assert.equal(resolveCasdoorClientSecret(ref), 'env-secret-value');
    delete process.env.TEST_CASDOOR_SECRET;
  });

  it('resolveCasdoorClientSecret：非引用明文直接透传（最小披露）', () => {
    assert.equal(resolveCasdoorClientSecret('plain-dev-secret'), 'plain-dev-secret');
  });

  it('deriveSessionSecret：同一明文派生稳定一致的密钥', () => {
    const a = deriveSessionSecret('same-secret');
    const b = deriveSessionSecret('same-secret');
    assert.deepEqual(Array.from(a), Array.from(b));
    assert.ok(a.length > 0);
  });

  it('deriveSessionSecret：不同明文派生不同密钥', () => {
    const a = deriveSessionSecret('secret-A');
    const b = deriveSessionSecret('secret-B');
    assert.notDeepEqual(Array.from(a), Array.from(b));
  });
});
