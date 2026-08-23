/**
 * OidcAuthSessionProvider 单元测试（B3 会话地基）：
 * 本地会话 JWT 验证、降级窗口（CAS-FAIL-001 15 分钟）、缺失/无效令牌返回 null。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import type { Request } from 'express';

import { OidcAuthSessionProvider } from './oidc-session-provider';

const secret = new TextEncoder().encode('test-secret-32-bytes-minimum!');

function makeRequest(token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  return { headers } as unknown as Request;
}

async function signToken(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: 'u_1001',
    name: '张三',
    email: 'zs@example.edu',
    iat: now,
    degraded: false,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('24h')
    .sign(secret);
}

describe('OidcAuthSessionProvider（CAS-FAIL-001 会话解析）', () => {
  const provider = new OidcAuthSessionProvider({
    sessionSecret: secret,
    casdoorAvailable: true,
  });

  it('有效会话 JWT → AuthSession（subjectId 来自服务端签发）', async () => {
    const token = await signToken();
    const session = await provider.resolveSession(makeRequest(token));
    assert.ok(session);
    assert.equal(session.subjectId, 'u_1001');
    assert.equal(session.mailCapable, true);
  });

  it('无 token → null（守卫 401）', async () => {
    assert.equal(await provider.resolveSession(makeRequest(null)), null);
  });

  it('非法/篡改 token → null', async () => {
    assert.equal(await provider.resolveSession(makeRequest('not-a-jwt')), null);
    const token = await signToken();
    const tampered = token.slice(0, -4) + 'xxxx';
    assert.equal(await provider.resolveSession(makeRequest(tampered)), null);
  });

  it('降级窗口：Casdoor 不可用 + 签发超 15 分钟 → null（CAS-FAIL-001）', async () => {
    const degradedProvider = new OidcAuthSessionProvider({
      sessionSecret: secret,
      casdoorAvailable: false,
    });
    const staleIat = Math.floor(Date.now() / 1000) - 16 * 60;
    const staleToken = await signToken({ iat: staleIat, degraded: true });
    assert.equal(await degradedProvider.resolveSession(makeRequest(staleToken)), null);
  });

  it('降级窗口：签发 15 分钟内 → 放行（degraded 会话）', async () => {
    const degradedProvider = new OidcAuthSessionProvider({
      sessionSecret: secret,
      casdoorAvailable: false,
    });
    const freshIat = Math.floor(Date.now() / 1000) - 5 * 60;
    const freshToken = await signToken({ iat: freshIat, degraded: true });
    const session = await degradedProvider.resolveSession(makeRequest(freshToken));
    assert.ok(session);
    assert.equal(session.subjectId, 'u_1001');
  });
});
