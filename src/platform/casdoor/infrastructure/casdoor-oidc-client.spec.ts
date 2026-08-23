/**
 * CasdoorOidcClient 出站超时测试（CAS-AUTH-001）：OIDC discovery / token 交换 /
 * get-user 均须在超时后中止挂起连接，避免 Casdoor 挂起无限阻塞 /api/auth/session。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CasdoorOidcClient, OIDC_FETCH_TIMEOUT_MS } from './casdoor-oidc-client';

const config = {
  endpoint: 'https://casdoor.example.org',
  clientId: 'client',
  clientSecret: 'secret',
  redirectUri: 'https://app.example.org/callback',
};

/** 构造一个永不主动完成、但随传入 signal 中止而拒绝的挂起 fetch */
function hangingFetch(): typeof fetch {
  return ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      const onAbort = () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
      // 若无 signal，永不完成（不该发生：fetchWithTimeout 总会带 signal）
    });
  }) as typeof fetch;
}

describe('CasdoorOidcClient 出站超时（CAS-AUTH-001）', () => {
  it('OIDC discovery 挂起：在超时内被中止并拒绝（不会无限阻塞）', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = hangingFetch();
    try {
      const client = new CasdoorOidcClient(config);
      const started = Date.now();
      await assert.rejects(
        client.buildAuthorizationUrl({ nonce: 'n1' }),
        (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
      );
      const elapsed = Date.now() - started;
      // 中止应发生在一个量级内的超时窗口，而不是放任永久挂起
      assert.ok(elapsed < OIDC_FETCH_TIMEOUT_MS * 3, `abort took too long: ${elapsed}ms`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('get-user 挂起同样在超时内中止（/api/auth/session 不阻塞）', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = hangingFetch();
    try {
      const client = new CasdoorOidcClient(config);
      const started = Date.now();
      await assert.rejects(
        client.fetchAccountState('access-token'),
        (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed < OIDC_FETCH_TIMEOUT_MS * 3, `abort took too long: ${elapsed}ms`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
