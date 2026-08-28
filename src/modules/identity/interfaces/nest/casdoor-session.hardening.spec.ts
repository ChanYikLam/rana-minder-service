/**
 * CasdoorSessionController 接真实实例前加固测试（2026-08-28）。
 *
 * 覆盖（对应实施计划阶段 3B/3C）：
 * - PKCE 全链路：login-url 携带 S256 challenge；establishSession 消费 nonce
 *   取回 verifier 并用于换码（challenge 与 verifier 密码学配对）；重放
 *   state（nonce 二次消费）→ 400；
 * - 匿名端点限流：同 IP 第二次请求 → 429 CAS-ERR-RATE_LIMITED；
 * - 学号来源（B1）：claims 学号优先；无来源时 "org:name" 限定形态兜底；
 *   建档唯一约束冲突 → 409 IFC-ERR-STUDENT-ID-CONFLICT（非 500）；
 * - 专用会话密钥强制：requireDedicatedSessionSecret 缺失/过短 → 503 fail-closed；
 * - Cookie 加固：Max-Age 与 HttpOnly/SameSite=Lax 落实。
 *
 * 身份链路桩：RS256 密钥对 + 本地 JWKS 路由（jose createRemoteJWKSet 经注入
 * fetch 拉取），id_token 以测试私钥签发，claims 可编程。
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import type { Response } from 'express';

import { CasdoorSessionController, SessionError } from './casdoor-session.controller';
import { InMemoryOidcNonceStore } from './oidc-nonce-store';
import { AuthRateLimiter } from './auth-rate-limiter';
import { CasdoorAvailability } from './casdoor-availability';
import type { RanaMinderConfig } from '../../../../config';
import { IdentityUnitOfWork } from '../../infrastructure/unit-of-work';
import { FakeDbAdapter } from '../../../../shared/testing/fake-db-adapter';
import type { SessionIdentitySnapshot } from '../../infrastructure/postgres-session-identity.repository';

const ISSUER = 'https://casdoor.test';
const CLIENT_ID = 'client-id';

const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/login/oauth/authorize`,
  token_endpoint: `${ISSUER}/api/login/oauth/access_token`,
  userinfo_endpoint: `${ISSUER}/api/userinfo`,
  jwks_uri: `${ISSUER}/.well-known/jwks`,
  end_session_endpoint: `${ISSUER}/api/logout`,
};

/** 会话身份建档桩的输入捕获（供学号断言） */
interface CapturedProvision {
  subjectId: string;
  casdoorOrg: string;
  casdoorName: string;
  studentId: string;
  displayName: string;
  email: string | null;
}

interface Harness {
  controller: CasdoorSessionController;
  calls: { url: string; init: RequestInit }[];
  cookies: Record<string, string>;
  res: Response;
  captured: { provision: CapturedProvision | null };
  /** 以测试私钥签发 id_token（claims 在构造时注入） */
  signIdToken: (nonce: string) => Promise<string>;
  setTokenBody: (body: Record<string, unknown>) => void;
  dispose: () => void;
}

interface HarnessOptions {
  configOverrides?: Partial<RanaMinderConfig['casdoor']>;
  sessionIdentity?: (input: CapturedProvision) => Promise<SessionIdentitySnapshot>;
  rateLimiter?: AuthRateLimiter;
  idTokenClaims?: Record<string, unknown>;
  accountState?: { status: string; data: Record<string, unknown> | null };
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  const kid = 'test-key-1';
  const claims = options.idTokenClaims ?? {};

  const captured = { provision: null as CapturedProvision | null };
  const sessionIdentity = options.sessionIdentity
    ? {
        ensureAndRead: async (input: CapturedProvision) => {
          captured.provision = input;
          return options.sessionIdentity!(input);
        },
      }
    : undefined;

  const calls: { url: string; init: RequestInit }[] = [];
  let tokenBody: Record<string, unknown> = { access_token: 'at-1', id_token: 'it-1' };

  const signIdToken = async (nonce: string): Promise<string> =>
    new SignJWT({
      sub: 'subject-1',
      name: 'admin',
      preferred_username: 'admin',
      email: 'admin@casdoor.test',
      email_verified: true,
      nonce,
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime('5m')
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .sign(privateKey);

  const fetchStub = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.includes('openid-configuration')) {
      return Response.json(DISCOVERY);
    }
    if (url.includes('jwks')) {
      return Response.json({ keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] });
    }
    if (url.includes('access_token')) {
      return Response.json(tokenBody);
    }
    if (url.includes('get-account')) {
      return Response.json(
        options.accountState ?? { status: 'ok', data: { isForbidden: false, isDeleted: false } },
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchStub;

  const config = {
    casdoor: {
      endpoint: ISSUER,
      clientId: CLIENT_ID,
      organization: 'gdmu',
      redirectUri: 'https://app.test/callback',
      clientSecretRef: 'client-secret',
      pkceEnabled: true,
      ...options.configOverrides,
    },
  } as RanaMinderConfig;

  const controller = new CasdoorSessionController(
    config,
    new CasdoorAvailability(true),
    new IdentityUnitOfWork(new FakeDbAdapter()),
    undefined,
    new InMemoryOidcNonceStore(),
    sessionIdentity,
    undefined,
    options.rateLimiter,
  );

  const cookies: Record<string, string> = {};
  const res = {
    setHeader: (key: string, value: string) => {
      cookies[key] = value;
    },
  } as unknown as Response;

  return {
    controller,
    calls,
    cookies,
    res,
    captured,
    signIdToken,
    setTokenBody: (body) => {
      tokenBody = body;
    },
    dispose: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function makeRequest(query: Record<string, string>): Parameters<
  CasdoorSessionController['establishSession']
>[0] {
  return {
    query,
    headers: {},
    ip: '10.0.0.1',
    socket: { remoteAddress: '10.0.0.1' },
    secure: false,
  } as never;
}

interface LoginStart {
  state: string;
  nonce: string;
  codeChallenge: string | null;
}

async function startLogin(h: Harness): Promise<LoginStart> {
  const { data } = await h.controller.getLoginUrl(makeRequest({}));
  const url = new URL(data.loginUrl);
  const state = url.searchParams.get('state') as string;
  const nonce = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'))['nonce'] as string;
  return { state, nonce, codeChallenge: url.searchParams.get('code_challenge') };
}

/** 标准登录直达：login-url → 注入配对 id_token → establishSession */
async function runLogin(h: Harness): Promise<{ code: number; data: Record<string, unknown> }> {
  const start = await startLogin(h);
  h.setTokenBody({ access_token: 'at-1', id_token: await h.signIdToken(start.nonce) });
  return (await h.controller.establishSession(
    makeRequest({ code: 'auth-code-1', state: start.state }),
    h.res,
  )) as unknown as { code: number; data: Record<string, unknown> };
}

function expectSessionError(
  status: number,
  code: string | undefined,
): (err: unknown) => boolean {
  return (err: unknown) =>
    err instanceof SessionError &&
    err.getStatus?.() === status &&
    (err as unknown as { code?: string }).code === code;
}

describe('会话控制器加固：PKCE 全链路', () => {
  it('login-url 携带 S256 challenge；establishSession 用服务端 verifier 换码并建立会话', async () => {
    const h = await makeHarness({ sessionIdentity: async (input) => snapshotFrom(input) });
    after(() => h.dispose());

    const start = await startLogin(h);
    assert.match(start.codeChallenge ?? '', /^[0-9A-Za-z_-]{43,}$/, 'S256 challenge 形态');

    h.setTokenBody({ access_token: 'at-1', id_token: await h.signIdToken(start.nonce) });
    const result = (await h.controller.establishSession(
      makeRequest({ code: 'auth-code-1', state: start.state }),
      h.res,
    )) as unknown as { code: number; data: Record<string, unknown> };

    assert.equal(result.code, 0);
    // 换码请求携带 code_verifier，且与授权 URL 的 challenge 密码学配对
    const tokenCall = h.calls.find((c) => c.url.includes('access_token'));
    assert.ok(tokenCall, '应发起换码请求');
    const form = new URLSearchParams(String(tokenCall.init.body));
    const verifier = form.get('code_verifier') ?? '';
    assert.match(verifier, /^[0-9A-Za-z_-]{43,}$/, 'verifier 来自服务端存储（43+ 字符）');
    const expectedChallenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    assert.equal(start.codeChallenge, expectedChallenge, 'challenge = BASE64URL(SHA256(verifier))');

    // Cookie 加固：HttpOnly + SameSite=Lax + Max-Age 对齐会话 JWT（默认 24h）
    const cookie = h.cookies['Set-Cookie'] ?? '';
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Max-Age=86400/);
  });

  it('重放 state（nonce 二次消费）→ 400，不再建立会话', async () => {
    const h = await makeHarness();
    after(() => h.dispose());

    const start = await startLogin(h);
    h.setTokenBody({ access_token: 'at-1', id_token: await h.signIdToken(start.nonce) });
    await h.controller.establishSession(
      makeRequest({ code: 'auth-code-1', state: start.state }),
      h.res,
    );
    await assert.rejects(
      h.controller.establishSession(
        makeRequest({ code: 'auth-code-2', state: start.state }),
        h.res,
      ),
      (err: unknown) => err instanceof SessionError && err.getStatus() === 400,
      '一次性 nonce 重放必须拒绝',
    );
  });
});

describe('会话控制器加固：学号来源（B1）', () => {
  it('无学号 claim → 兜底 "org:name" 限定形态（跨组织同名不撞全局唯一约束）', async () => {
    const h = await makeHarness({ sessionIdentity: async (input) => snapshotFrom(input) });
    after(() => h.dispose());
    const result = await runLogin(h);
    assert.equal(result.code, 0);
    assert.equal(h.captured.provision?.studentId, 'gdmu:admin');
  });

  it('claims 学号优先于兜底形态', async () => {
    const h = await makeHarness({
      idTokenClaims: { studentId: '20231234567' },
      sessionIdentity: async (input) => snapshotFrom(input),
    });
    after(() => h.dispose());
    const result = await runLogin(h);
    assert.equal(result.code, 0);
    assert.equal(h.captured.provision?.studentId, '20231234567');
  });

  it('建档唯一约束冲突 → 409 IFC-ERR-STUDENT-ID-CONFLICT（显式业务错误，非 500）', async () => {
    const h = await makeHarness({
      sessionIdentity: async () => {
        const err = new Error(
          'duplicate key value violates unique constraint "uq_users_student_id"',
        );
        (err as { code?: string }).code = '23505';
        throw err;
      },
    });
    after(() => h.dispose());
    await assert.rejects(
      runLogin(h),
      expectSessionError(409, 'IFC-ERR-STUDENT-ID-CONFLICT'),
    );
  });
});

describe('会话控制器加固：匿名端点限流', () => {
  it('同 IP 连续第二次认证请求 → 429 CAS-ERR-RATE_LIMITED', async () => {
    const h = await makeHarness({
      rateLimiter: new AuthRateLimiter({ maxPerKeyPerWindow: 1 }),
    });
    after(() => h.dispose());
    await h.controller.getLoginUrl(makeRequest({})); // 第一次：放行并耗尽配额
    await assert.rejects(
      h.controller.getLoginUrl(makeRequest({})),
      expectSessionError(429, 'CAS-ERR-RATE_LIMITED'),
    );
    // 会话建立路径共用同一限流器（防 code/nonce 盲猜）
    await assert.rejects(
      h.controller.establishSession(
        makeRequest({ code: 'x', state: Buffer.from('{"nonce":"n"}').toString('base64url') }),
        h.res,
      ),
      expectSessionError(429, 'CAS-ERR-RATE_LIMITED'),
    );
  });
});

describe('会话控制器加固：专用会话密钥强制', () => {
  it('requireDedicatedSessionSecret=true 且未配置 → 503 fail-closed', async () => {
    const h = await makeHarness({ configOverrides: { requireDedicatedSessionSecret: true } });
    after(() => h.dispose());
    await assert.rejects(
      h.controller.getLoginUrl(makeRequest({})),
      expectSessionError(503, 'CAS-ERR-SESSION_SECRET_REQUIRED'),
    );
  });

  it('requireDedicatedSessionSecret=true 且专用密钥过短（<32）→ 503', async () => {
    const h = await makeHarness({
      configOverrides: { requireDedicatedSessionSecret: true, sessionSecretRef: 'short' },
    });
    after(() => h.dispose());
    await assert.rejects(
      h.controller.getLoginUrl(makeRequest({})),
      expectSessionError(503, 'CAS-ERR-SESSION_SECRET_REQUIRED'),
    );
  });

  it('配置合规（≥32 字符专用密钥）→ 正常签发登录 URL', async () => {
    const h = await makeHarness({
      configOverrides: { requireDedicatedSessionSecret: true, sessionSecretRef: 'x'.repeat(48) },
    });
    after(() => h.dispose());
    const { data } = await h.controller.getLoginUrl(makeRequest({}));
    assert.ok(data.loginUrl.startsWith(ISSUER));
  });
});

// ---- 测试辅助 ----

function snapshotFrom(input: CapturedProvision): SessionIdentitySnapshot {
  return {
    subjectId: input.subjectId,
    studentId: input.studentId,
    name: input.displayName,
    email: 'admin@casdoor.test',
    phone: '',
    avatar: null,
    emailVerified: true,
    profileComplete: true,
  };
}
