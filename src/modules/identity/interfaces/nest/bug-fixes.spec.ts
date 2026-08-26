/**
 * BUG-008/016/017 修复验证测试。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryOidcNonceStore, type OidcNonceStore } from './oidc-nonce-store';
import { deriveSessionSecret } from './session-secret';
import { isSecureRequest } from './secure-request';

describe('BUG-008：nonce 存储可注入（多实例共享）', () => {
  it('OidcNonceStore 接口契约：issue + consume（一次性）', () => {
    const store: OidcNonceStore = new InMemoryOidcNonceStore();
    store.issue('nonce-abc');
    assert.equal(store.consume('nonce-abc'), true, '首次消费应成功');
    assert.equal(store.consume('nonce-abc'), false, '一次性 nonce 二次消费应拒绝');
    assert.equal(store.consume('never-issued'), false);
  });

  it('自定义共享存储实现可替换内存桩（接口兼容性）', () => {
    // 模拟 Redis 等共享存储实现
    class SharedNonceStore implements OidcNonceStore {
      private readonly backing = new Map<string, number>();
      issue(nonce: string): void {
        this.backing.set(nonce, Date.now());
      }
      consume(nonce: string): boolean {
        return this.backing.delete(nonce);
      }
    }
    const shared: OidcNonceStore = new SharedNonceStore();
    shared.issue('shared-nonce');
    assert.equal(shared.consume('shared-nonce'), true);
  });
});

describe('BUG-016：Cookie Secure 由配置驱动', () => {
  it('生产环境始终返回 Secure=true（不信任 req.secure / 请求头）', () => {
    // 生产下无论 req.secure 真假都返回 true，绝不信任客户端可伪造的请求头
    assert.equal(isSecureRequest('production', false), true, '生产 + req.secure=false 也应 Secure');
    assert.equal(isSecureRequest('production', true), true, '生产 + req.secure=true 应为 Secure');
    assert.equal(isSecureRequest('production', undefined as unknown as boolean), true);
  });

  it('非生产环境：仅由 req.secure 决定（不信任 x-forwarded-proto）', () => {
    // 非生产下不再读取 x-forwarded-proto，仅依赖 Express 的 req.secure
    assert.equal(isSecureRequest('development', true), true, 'dev + req.secure=true → Secure');
    assert.equal(
      isSecureRequest('development', false),
      false,
      'dev + req.secure=false → 非 Secure',
    );
    assert.equal(
      isSecureRequest(undefined, false),
      false,
      '无 NODE_ENV + req.secure=false → 非 Secure',
    );
    assert.equal(isSecureRequest('test', false), false, 'test + req.secure=false → 非 Secure');
  });
});

describe('BUG-017：会话密钥独立派生', () => {
  it('提供专用密钥（≥32 字符）→ 使用 v2 口径，与 clientSecret 解耦', () => {
    const dedicated = 'a'.repeat(32);
    const secret1 = deriveSessionSecret('casdoor-client-secret', dedicated);
    // v2 口径应产生与 v1 不同的密钥
    const legacySecret = deriveSessionSecret('casdoor-client-secret');
    assert.notDeepEqual(secret1, legacySecret, 'v2 密钥不应等于 v1 回退');
  });

  it('未配置专用密钥 → 回退 v1 口径（向后兼容）', () => {
    const s1 = deriveSessionSecret('test-secret', undefined);
    const s2 = deriveSessionSecret('test-secret');
    assert.deepEqual(s1, s2, '无专用密钥时应使用 v1 口径');
  });

  it('专用密钥过短（<32 字符）→ 回退 v1', () => {
    const short = deriveSessionSecret('test-secret', 'short');
    const legacy = deriveSessionSecret('test-secret');
    assert.deepEqual(short, legacy, '短专用密钥应回退 v1');
  });
});
