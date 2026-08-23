/**
 * OidcNonceStore 单元测试（CAS-CAP-004 登录 CSRF/会话固定防护）。
 *
 * 校验：签发后可消费、一次性消费、未签发拒绝、过期拒绝、消费后不可复用。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryOidcNonceStore } from './oidc-nonce-store';

describe('InMemoryOidcNonceStore（登录 nonce 服务端持久化）', () => {
  it('签发后可一次性消费', () => {
    const store = new InMemoryOidcNonceStore();
    const nonce = 'nonce-1';
    store.issue(nonce);
    assert.equal(store.consume(nonce), true);
  });

  it('一次性消费：消费后再消费返回 false（防重放）', () => {
    const store = new InMemoryOidcNonceStore();
    const nonce = 'nonce-2';
    store.issue(nonce);
    assert.equal(store.consume(nonce), true);
    assert.equal(store.consume(nonce), false);
  });

  it('未签发（或已过期）的 nonce 拒绝消费（fail-closed）', () => {
    const store = new InMemoryOidcNonceStore();
    assert.equal(store.consume('never-issued'), false);
  });

  it('过期 nonce 拒绝消费', () => {
    const store = new InMemoryOidcNonceStore();
    const nonce = 'nonce-expired';
    // 负 TTL 保证在消费时已过期
    store.issue(nonce, -1000);
    assert.equal(store.consume(nonce), false);
  });
});
