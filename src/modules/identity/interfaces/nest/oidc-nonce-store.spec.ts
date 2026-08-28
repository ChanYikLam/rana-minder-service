/**
 * OidcNonceStore 单元测试（CAS-CAP-004 登录 CSRF/会话固定防护）。
 *
 * 校验：签发后可消费（载荷语义）、一次性消费、未签发拒绝、过期拒绝、
 * 消费后不可复用、PKCE verifier 载荷随消费一次性取回。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryOidcNonceStore } from './oidc-nonce-store';

describe('InMemoryOidcNonceStore（登录 nonce 服务端持久化）', () => {
  it('签发后可一次性消费（无载荷返回空串）', async () => {
    const store = new InMemoryOidcNonceStore();
    const nonce = 'nonce-1';
    await store.issue(nonce);
    assert.equal(await store.consume(nonce), '');
  });

  it('一次性消费：消费后再消费返回 null（防重放）', async () => {
    const store = new InMemoryOidcNonceStore();
    const nonce = 'nonce-2';
    await store.issue(nonce);
    assert.equal(await store.consume(nonce), '');
    assert.equal(await store.consume(nonce), null);
  });

  it('未签发（或已过期）的 nonce 拒绝消费（fail-closed）', async () => {
    const store = new InMemoryOidcNonceStore();
    assert.equal(await store.consume('never-issued'), null);
  });

  it('过期 nonce 拒绝消费', async () => {
    const store = new InMemoryOidcNonceStore();
    const nonce = 'nonce-expired';
    // 负 TTL 保证在消费时已过期
    await store.issue(nonce, -1000);
    assert.equal(await store.consume(nonce), null);
  });

  it('载荷（PKCE code_verifier）随消费一次性取回，不可二次取回', async () => {
    const store = new InMemoryOidcNonceStore();
    await store.issue('nonce-pkce', undefined, 'verifier-abc');
    assert.equal(await store.consume('nonce-pkce'), 'verifier-abc');
    assert.equal(await store.consume('nonce-pkce'), null);
  });

  it('不同 nonce 载荷互不串扰', async () => {
    const store = new InMemoryOidcNonceStore();
    await store.issue('nonce-a', undefined, 'verifier-a');
    await store.issue('nonce-b', undefined, 'verifier-b');
    assert.equal(await store.consume('nonce-b'), 'verifier-b');
    assert.equal(await store.consume('nonce-a'), 'verifier-a');
  });
});
