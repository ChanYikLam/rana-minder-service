/**
 * CasdoorSessionController 登出吊销（BUG-007）安全接线测试。
 *
 * 焦点：登出吊销必须验签通过后才取 sub，杜绝未鉴权伪造任意主体吊销（评审 Critical）。
 * - 携带有效会话 JWT 登出 → 只吊销该已认证主体（验证通过取 sub）；
 * - 携带伪造/篡改 token 登出 → 不吊销任何主体（验签失败 → null → 仅清 Cookie）；
 * - 吊销写入在身份域工作单元事务内（SEC-CTL-004：禁止脱离事务读写）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import type { Response } from 'express';

import { CasdoorSessionController } from './casdoor-session.controller';
import { deriveSessionSecret } from './session-secret';
import { CasdoorAvailability } from './casdoor-availability';
import type { RanaMinderConfig } from '../../../../config';
import { IdentityUnitOfWork } from '../../infrastructure/unit-of-work';
import { FakeDbAdapter } from '../../../../shared/testing/fake-db-adapter';
import type { SessionRevocationPort } from '../../application/ports/session-revocation.port';

const CLIENT_SECRET = 'test-casdoor-client-secret';
const SESSION_SECRET = deriveSessionSecret(CLIENT_SECRET);

function makeConfig(): RanaMinderConfig {
  return {
    casdoor: {
      endpoint: 'https://casdoor.test',
      clientId: 'client-id',
      organization: 'org',
      redirectUri: 'https://app.test/cb',
      clientSecretRef: CLIENT_SECRET,
    },
  } as RanaMinderConfig;
}

/** 用正确密钥签发会话 JWT（模拟真实登出请求携带的合法令牌）。 */
async function signValidToken(sub: string): Promise<string> {
  return new SignJWT({ sub, iat: Math.floor(Date.now() / 1000) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .setExpirationTime('24h')
    .sign(SESSION_SECRET);
}

/** 用错误密钥签发（模拟伪造/篡改令牌，验签必须失败）。 */
async function signForgedToken(sub: string): Promise<string> {
  const forged = new TextEncoder().encode('attacker-controlled-secret');
  return new SignJWT({ sub, iat: Math.floor(Date.now() / 1000) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(Math.floor(Date.now() / 1000))
    .setExpirationTime('24h')
    .sign(forged);
}

interface Harness {
  controller: CasdoorSessionController;
  revocations: string[];
  response: Response;
  cookies: Record<string, string>;
}

function makeHarness(): Harness {
  const revocations: string[] = [];
  const revocationPort: SessionRevocationPort = {
    invalidateSessions: async () => undefined,
    getRevocation: async () => null,
    invalidateAllSessions: async (subjectId) => {
      revocations.push(subjectId);
      return 1;
    },
  };
  const uow = new IdentityUnitOfWork(new FakeDbAdapter());
  const controller = new CasdoorSessionController(
    makeConfig(),
    new CasdoorAvailability(true),
    uow,
    revocationPort,
  );
  const cookies: Record<string, string> = {};
  const response = {
    setHeader: (key: string, value: string) => {
      cookies[key] = value;
    },
  } as unknown as Response;
  return { controller, revocations, response, cookies };
}

function reqWithBearer(token: string) {
  return { headers: { authorization: `Bearer ${token}` } } as never;
}

describe('CasdoorSessionController 登出吊销（BUG-007 安全接线）', () => {
  it('有效会话令牌登出：验签通过后吊销该已认证主体', async () => {
    const h = makeHarness();
    const token = await signValidToken('user-1');
    const result = await h.controller.logout(reqWithBearer(token), h.response);
    assert.deepEqual(result, { code: 0, data: { endSessionUrl: null } });
    assert.deepEqual(h.revocations, ['user-1'], '只吊销验签通过的当前主体');
    assert.match(h.cookies['Set-Cookie'] ?? '', /session_token=;/, '清除会话 Cookie');
  });

  it('伪造令牌登出：验签失败不吊销任何主体（防未鉴权任意撤销）', async () => {
    const h = makeHarness();
    const token = await signForgedToken('victim-user');
    const result = await h.controller.logout(reqWithBearer(token), h.response);
    assert.deepEqual(result, { code: 0, data: { endSessionUrl: null } });
    assert.deepEqual(h.revocations, [], '伪造令牌必须被拒，不得吊销任意主体');
  });

  it('无令牌登出：不吊销，仅清 Cookie', async () => {
    const h = makeHarness();
    const result = await h.controller.logout({ headers: {} } as never, h.response);
    assert.deepEqual(result, { code: 0, data: { endSessionUrl: null } });
    assert.deepEqual(h.revocations, [], '无有效令牌不触发吊销');
  });

  it('吊销写入失败不阻断 Cookie 清除', async () => {
    const revocations: string[] = [];
    const failingPort: SessionRevocationPort = {
      invalidateSessions: async () => undefined,
      getRevocation: async () => null,
      invalidateAllSessions: async (subjectId) => {
        revocations.push(subjectId);
        throw new Error('db down');
      },
    };
    const uow = new IdentityUnitOfWork(new FakeDbAdapter());
    const controller = new CasdoorSessionController(
      makeConfig(),
      new CasdoorAvailability(true),
      uow,
      failingPort,
    );
    const cookies: Record<string, string> = {};
    const res = {
      setHeader: (key: string, value: string) => {
        cookies[key] = value;
      },
    } as unknown as Response;
    const token = await signValidToken('user-2');
    const result = await controller.logout(reqWithBearer(token), res);
    assert.deepEqual(result, { code: 0, data: { endSessionUrl: null } }, '吊销失败仍返回登出成功');
    assert.deepEqual(revocations, ['user-2']);
    assert.match(cookies['Set-Cookie'] ?? '', /session_token=;/, 'Cookie 已清除');
  });
});
