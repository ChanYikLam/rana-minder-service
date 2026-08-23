/**
 * OidcAuthSessionProvider 单元测试（B3 会话地基）：
 * 本地会话 JWT 验证、实时账号状态复查（CAS-REC-002）、降级窗口（CAS-FAIL-001
 * 15 分钟）、缺失/无效令牌返回 null。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import type { Request } from 'express';

import { OidcAuthSessionProvider, type AccountStateObservation } from './oidc-session-provider';

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

interface TestProviderOptions {
  checkAccountState?: (subjectId: string) => Promise<AccountStateObservation>;
  isCasdoorAvailable?: () => boolean;
}

function buildProvider(opts: TestProviderOptions = {}): OidcAuthSessionProvider {
  return new OidcAuthSessionProvider({
    sessionSecret: secret,
    checkAccountState: opts.checkAccountState ?? (async () => 'ACTIVE'),
    isCasdoorAvailable: opts.isCasdoorAvailable ?? (() => true),
  });
}

describe('OidcAuthSessionProvider（CAS-FAIL-001 会话解析）', () => {
  it('有效会话 JWT → AuthSession（subjectId 来自服务端签发）', async () => {
    const provider = buildProvider();
    const token = await signToken();
    const session = await provider.resolveSession(makeRequest(token));
    assert.ok(session);
    assert.equal(session.subjectId, 'u_1001');
    assert.equal(session.mailCapable, true);
  });

  it('无 token → null（守卫 401）', async () => {
    const provider = buildProvider();
    assert.equal(await provider.resolveSession(makeRequest(null)), null);
  });

  it('非法/篡改 token → null', async () => {
    const provider = buildProvider();
    assert.equal(await provider.resolveSession(makeRequest('not-a-jwt')), null);
    const token = await signToken();
    const tampered = token.slice(0, -4) + 'xxxx';
    assert.equal(await provider.resolveSession(makeRequest(tampered)), null);
  });

  it('实时读回：账号已禁用 → null（CAS-REC-002）', async () => {
    const provider = buildProvider({ checkAccountState: async () => 'DISABLED' });
    const token = await signToken();
    assert.equal(await provider.resolveSession(makeRequest(token)), null);
  });

  it('实时读回：账号已删除 → null（CAS-REC-002）', async () => {
    const provider = buildProvider({ checkAccountState: async () => 'DELETED' });
    const token = await signToken();
    assert.equal(await provider.resolveSession(makeRequest(token)), null);
  });

  it('实时读回：无法确定（Casdoor 不可达）→ 不误伤非降级会话', async () => {
    const provider = buildProvider({ checkAccountState: async () => null });
    const token = await signToken();
    const session = await provider.resolveSession(makeRequest(token));
    assert.ok(session);
  });

  it('降级窗口：Casdoor 不可用 + 签发超 15 分钟 → null（CAS-FAIL-001）', async () => {
    const provider = buildProvider({
      checkAccountState: async () => null,
      isCasdoorAvailable: () => false,
    });
    const staleIat = Math.floor(Date.now() / 1000) - 16 * 60;
    const staleToken = await signToken({ iat: staleIat, degraded: true });
    assert.equal(await provider.resolveSession(makeRequest(staleToken)), null);
  });

  it('降级窗口：签发 15 分钟内 → 放行（degraded 会话）', async () => {
    const provider = buildProvider({
      checkAccountState: async () => null,
      isCasdoorAvailable: () => false,
    });
    const freshIat = Math.floor(Date.now() / 1000) - 5 * 60;
    const freshToken = await signToken({ iat: freshIat, degraded: true });
    const session = await provider.resolveSession(makeRequest(freshToken));
    assert.ok(session);
    assert.equal(session.subjectId, 'u_1001');
  });

  it('降级窗口：Casdoor 恢复可用后，陈旧降级会话不被拒绝', async () => {
    const provider = buildProvider({
      checkAccountState: async () => 'ACTIVE',
      isCasdoorAvailable: () => true,
    });
    const staleIat = Math.floor(Date.now() / 1000) - 30 * 60;
    const staleToken = await signToken({ iat: staleIat, degraded: true });
    const session = await provider.resolveSession(makeRequest(staleToken));
    assert.ok(session);
  });
});
