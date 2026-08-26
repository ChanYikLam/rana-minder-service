/**
 * 会话吊销读侧接线测试（BUG-003/007；IDN-008 ≤5s 返回 401）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { OidcAuthSessionProvider } from './oidc-session-provider';

const SECRET = new TextEncoder().encode('test-secret-key-at-least-32-chars!');
const NOW = Date.now();

/** 签发测试 JWT */
async function sign(sub: string, iat: number): Promise<string> {
  const { SignJWT } = await import('jose');
  return new SignJWT({ sub, iat })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(Math.floor(iat / 1000))
    .setExpirationTime('24h')
    .sign(SECRET);
}

function makeRequest(token: string) {
  return { headers: { authorization: `Bearer ${token}` } } as never;
}

describe('OidcAuthSessionProvider 撤销读侧（BUG-003）', () => {
  it('未注入 revocationReader：不校验吊销，正常返回会话', async () => {
    const provider = new OidcAuthSessionProvider({
      sessionSecret: SECRET,
      casdoorAvailable: true,
    });
    const token = await sign('u1', NOW - 5000);
    const session = await provider.resolveSession(makeRequest(token));
    assert.ok(session);
    assert.equal(session.subjectId, 'u1');
  });

  it('已注入 revocationReader + 未吊销 → 正常返回会话', async () => {
    const token = await sign('u2', NOW - 5000);
    const provider = new OidcAuthSessionProvider({
      sessionSecret: SECRET,
      casdoorAvailable: true,
      revocationReader: async () => ({
        revokeVersion: 0,
        revokedAt: null,
      }),
    });
    const session = await provider.resolveSession(makeRequest(token));
    assert.ok(session);
    assert.equal(session.subjectId, 'u2');
  });

  it('已吊销：revokedAt > iat → 拒绝返回 null', async () => {
    // 令牌签发于 5s 前
    const token = await sign('u3', NOW - 5000);
    // 吊销发生在 2s 前（晚于令牌签发 → 已被吊销）
    const revokedAt = new Date(NOW - 2000).toISOString();
    const provider = new OidcAuthSessionProvider({
      sessionSecret: SECRET,
      casdoorAvailable: true,
      revocationReader: async () => ({
        revokeVersion: 1,
        revokedAt,
      }),
    });
    const session = await provider.resolveSession(makeRequest(token));
    assert.equal(session, null);
  });

  it('未吊销但 revokedAt 早于 iat → 允许通过', async () => {
    // 令牌签发于 5s 前，上次吊销在 10s 前 → 本次签发晚于吊销 → 有效
    const token = await sign('u4', NOW - 5000);
    const revokedAt = new Date(NOW - 10000).toISOString();
    const provider = new OidcAuthSessionProvider({
      sessionSecret: SECRET,
      casdoorAvailable: true,
      revocationReader: async () => ({
        revokeVersion: 1,
        revokedAt,
      }),
    });
    const session = await provider.resolveSession(makeRequest(token));
    assert.ok(session);
  });

  it('getRevocation 返回 null（从未被吊销）→ 允许通过', async () => {
    const token = await sign('u5', NOW - 5000);
    const provider = new OidcAuthSessionProvider({
      sessionSecret: SECRET,
      casdoorAvailable: true,
      revocationReader: async () => null,
    });
    const session = await provider.resolveSession(makeRequest(token));
    assert.ok(session);
  });
});
