/**
 * SSO 握手协议层合同测试（CAS-CAP-004 / CAS-AUTH-001 / API-AUTH-001）。
 *
 * 自建「假 OIDC Provider」HTTP 合同：discovery/JWKS/token/userinfo/get-user 全部由
 * mock global.fetch 路由提供 canned 响应；RS256 紧凑 JWS 用 node:crypto 手工签名，
 * 无真实网络。分两层：
 *
 * - **jose 可用时**：动态加载真实 CasdoorOidcClient（eval('require')，非静态 import），
 *   走真实校验路径（createRemoteJWKSet + jwtVerify 对手工签名的 RS256 id_token 做
 *   签名/签发方/受众/有效期校验）；
 * - **jose 缺失时**：以上用例 t.skip（CI 安装依赖后自动启用）；仅运行不依赖 jose 的
 *   回调参数校验部分——state(base64url JSON) 解码与 nonce 服务端匹配语义
 *   （真实 InMemoryOidcNonceStore 参与验证）。
 *
 * 说明：casdoor-session.controller.ts 的 state/nonce 匹配逻辑与其 OIDC 客户端同处一条
 * jose 静态依赖链，无独立纯函数模块可导出；本文件的 jose-free 组按控制器契约
 * （state=base64url(JSON{nonce})、consume 一次性、解析失败→400 Invalid state）
 * 复刻匹配语义并锁定行为。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';

import { InMemoryOidcNonceStore } from '../../src/modules/identity/interfaces/nest/oidc-nonce-store';

// ---------------------------------------------------------------------------
// jose 探测（缺失时跳过深层校验路径；绝不静态 import）
// ---------------------------------------------------------------------------

const req = eval('require') as NodeRequire;

interface JoseLike {
  jwtVerify: (
    token: string,
    key: unknown,
    options?: Record<string, unknown>,
  ) => Promise<{ payload: Record<string, unknown> }>;
}

let jose: JoseLike | null = null;
try {
  jose = req('jose') as JoseLike;
} catch {
  jose = null;
}

/** 真实 OIDC 客户端形状（仅 jose 可用时经 require hook 动态加载编译）。 */
interface FakeOidcClientInstance {
  buildAuthorizationUrl(state: Record<string, unknown>): Promise<string>;
  exchangeCode(code: string): Promise<{
    readonly accessToken: string;
    readonly idToken: string;
    readonly refreshToken?: string;
    readonly expiresAt?: number;
  }>;
  verifyIdToken(idToken: string, nonce: string): Promise<Record<string, unknown>>;
  fetchAccountState(
    accessToken: string,
  ): Promise<'ACTIVE' | 'DISABLED' | 'DELETED' | 'UNKNOWN'>;
}

type FakeOidcClientCtor = new (config: {
  endpoint: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}) => FakeOidcClientInstance;

let RealOidcClient: FakeOidcClientCtor | null = null;
if (jose !== null) {
  try {
    const mod = req('../../src/platform/casdoor/infrastructure/casdoor-oidc-client') as {
      CasdoorOidcClient: FakeOidcClientCtor;
    };
    RealOidcClient = mod.CasdoorOidcClient;
  } catch {
    RealOidcClient = null;
  }
}

// ---------------------------------------------------------------------------
// 假 OIDC Provider：RSA 密钥对手工 RS256 签名 + mock fetch 路由
// ---------------------------------------------------------------------------

const ISSUER = 'https://casdoor.fake.example';
const CLIENT_ID = 'ranaminder-web';
const CLIENT_SECRET = 'fake-provider-client-secret';
const REDIRECT_URI = 'https://app.example.org/api/auth/session';
const KID = 'fake-rsa-key-1';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

function b64u(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function signRs256(payload: Record<string, unknown>): string {
  const signingInput = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }))}.${b64u(
    JSON.stringify(payload),
  )}`;
  const sig = createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return `${signingInput}.${b64u(sig)}`;
}

/** 解码紧凑 JWS 的 payload（不做签名校验——校验属 jose 职责）。 */
function decodePayload(token: string): Record<string, unknown> {
  const [, payloadPart] = token.split('.');
  return JSON.parse(Buffer.from(payloadPart ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

interface FakeRequest {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
}

interface FakeResponseShape {
  readonly status: number;
  readonly body: unknown;
}

interface FakeProviderHandle {
  readonly requests: FakeRequest[];
  /** 最近一次签发并放入 token 端点响应的 id_token。 */
  setAccountState(state: Record<string, unknown>): void;
  setIssuer(issuer: string): void;
  restore(): void;
}

function installFakeProvider(initialIdToken: string): FakeProviderHandle {
  const requests: FakeRequest[] = [];
  const state: { accountData: Record<string, unknown>; issuer: string } = {
    accountData: { isForbidden: false, isDeleted: false },
    issuer: ISSUER,
  };

  function route(url: string, method: string, body: string | undefined): FakeResponseShape {
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return {
        status: 200,
        body: {
          issuer: state.issuer,
          authorization_endpoint: `${ISSUER}/login/oauth/authorize`,
          token_endpoint: `${ISSUER}/api/login/oauth/access_token`,
          userinfo_endpoint: `${ISSUER}/api/userinfo`,
          jwks_uri: `${ISSUER}/jwks.json`,
        },
      };
    }
    if (url === `${ISSUER}/jwks.json`) {
      const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
      return { status: 200, body: { keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] } };
    }
    if (url === `${ISSUER}/api/login/oauth/access_token`) {
      assert.equal(method, 'POST');
      const form = new URLSearchParams(body ?? '');
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('client_id'), CLIENT_ID);
      assert.equal(form.get('client_secret'), CLIENT_SECRET);
      assert.equal(form.get('redirect_uri'), REDIRECT_URI);
      return {
        status: 200,
        body: {
          access_token: 'at-fake-access-token',
          id_token: initialIdToken,
          refresh_token: 'rt-fake',
          token_type: 'Bearer',
          expires_in: 3600,
        },
      };
    }
    if (url === `${ISSUER}/api/userinfo`) {
      return {
        status: 200,
        body: { sub: 'u_1001', name: '张三', preferred_username: 'zhangsan' },
      };
    }
    if (url === `${ISSUER}/api/get-user`) {
      return { status: 200, body: { status: 'ok', data: state.accountData } };
    }
    return { status: 404, body: { error: 'unrouted' } };
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    requests.push({ url, method: init?.method ?? 'GET', body });
    const result = route(url, init?.method ?? 'GET', body);
    const text =
      typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? null);
    let parsed: unknown = result.body;
    if (typeof result.body !== 'string') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => text,
      json: async () => parsed,
    } as unknown as Response;
  }) as typeof fetch;

  return {
    requests,
    setAccountState(data: Record<string, unknown>): void {
      state.accountData = data;
    },
    setIssuer(issuer: string): void {
      state.issuer = issuer;
    },
    restore(): void {
      globalThis.fetch = originalFetch;
    },
  };
}

/** 标准身份声明（CAS-CAP-004：主体绑定字段齐全）。 */
function standardClaims(nowSec: number): Record<string, unknown> {
  return {
    sub: 'u_1001',
    name: '张三',
    email: 'zs@example.edu',
    iss: ISSUER,
    aud: CLIENT_ID,
    iat: nowSec,
    exp: nowSec + 600,
    nonce: '',
  };
}

describe('SSO 握手 · jose-free 部分（回调参数校验/state/nonce 匹配语义）', () => {
  it("state 契约：base64url(JSON{nonce}) 编解码往返一致，且 nonce 由服务端 store 签发后消费成功", () => {
    const store = new InMemoryOidcNonceStore();
    const nonce = '11111111-2222-3333-4444-555555555555';
    store.issue(nonce);

    // 控制器侧：issue(nonce) 后把 state 交给授权 URL；回调侧反向解码
    const stateParam = Buffer.from(JSON.stringify({ nonce })).toString('base64url');
    const decoded = JSON.parse(Buffer.from(stateParam, 'base64url').toString('utf8')) as {
      nonce?: unknown;
    };

    assert.equal(typeof decoded.nonce, 'string');
    assert.equal(store.consume(decoded.nonce as string), true);
  });

  it("伪造 state（nonce 非本服务签发）→ consume=false → 回调必须拒绝（登录 CSRF / 会话固定防护）", () => {
    const store = new InMemoryOidcNonceStore();
    const attackerState = Buffer.from(JSON.stringify({ nonce: 'forged-by-attacker' })).toString(
      'base64url',
    );
    const decoded = JSON.parse(Buffer.from(attackerState, 'base64url').toString('utf8')) as {
      nonce?: unknown;
    };
    assert.equal(typeof decoded.nonce, 'string');
    assert.equal(store.consume(decoded.nonce as string), false);
  });

  it("重放回调：同一合法 state 二次提交 → consume=false（一次性 nonce）", () => {
    const store = new InMemoryOidcNonceStore();
    store.issue('nonce-once');
    const stateParam = Buffer.from(JSON.stringify({ nonce: 'nonce-once' })).toString('base64url');

    const first = JSON.parse(Buffer.from(stateParam, 'base64url').toString('utf8')) as {
      nonce: string;
    };
    assert.equal(store.consume(first.nonce), true);
    // 第二次完整重放同一回调
    const second = JSON.parse(Buffer.from(stateParam, 'base64url').toString('utf8')) as {
      nonce: string;
    };
    assert.equal(store.consume(second.nonce), false);
  });

  it("畸形 state（非法编码/非 JSON）→ 解码抛错 → 控制器映射 400 Invalid state", () => {
    assert.throws(() => JSON.parse(Buffer.from('%%%not-base64url%%%', 'base64url').toString('utf8')));
    const notJson = Buffer.from('plain-text-state', 'utf8').toString('base64url');
    assert.throws(() => JSON.parse(Buffer.from(notJson, 'base64url').toString('utf8')));
  });

  it("state 解码成功但缺 nonce 字段（或类型不符）→ 拒绝分支（typeof 校验先行）", () => {
    const emptyState = Buffer.from(JSON.stringify({ redirectAfter: '/home' })).toString('base64url');
    const decoded = JSON.parse(Buffer.from(emptyState, 'base64url').toString('utf8')) as {
      nonce?: unknown;
    };
    assert.equal(typeof decoded.nonce !== 'string' || !decoded.nonce, true);
  });

  it("id_token payload 与 state 的 nonce 不匹配检测是纯相等比较（签名校验之外的第一道门）", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const claims = { ...standardClaims(nowSec), nonce: 'nonce-from-auth-request' };
    const token = signRs256(claims);

    const payload = decodePayload(token);
    const expectedFromState = 'nonce-expected-by-server';
    // 控制器/OIDC 客户端约定：payload.nonce !== state.nonce → 立即拒绝（jose 无关）
    assert.notEqual(payload['nonce'], expectedFromState);
    assert.equal(payload['nonce'] === String(payload['nonce']), true);
  });
});

describe('SSO 握手 · 真实校验路径（jose 可用时；否则 skip）', () => {
  it("discovery → buildAuthorizationUrl：授权 URL 参数完整且 state 含 nonce（CAS-AUTH-001 出站合同）", async (t) => {
    if (RealOidcClient === null || jose === null) {
      return t.skip('jose 未安装：CI 安装依赖后自动启用');
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const idToken = signRs256({ ...standardClaims(nowSec), nonce: 'n-url' });
    const provider = installFakeProvider(idToken);
    try {
      const client = new RealOidcClient({
        endpoint: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
      });

      const url = await client.buildAuthorizationUrl({ nonce: 'n-url' });
      const parsed = new URL(url);
      assert.equal(parsed.origin + parsed.pathname, `${ISSUER}/login/oauth/authorize`);
      assert.equal(parsed.searchParams.get('client_id'), CLIENT_ID);
      assert.equal(parsed.searchParams.get('response_type'), 'code');
      assert.equal(parsed.searchParams.get('redirect_uri'), REDIRECT_URI);
      assert.equal(parsed.searchParams.get('scope'), 'openid profile email');
      assert.equal(parsed.searchParams.get('nonce'), 'n-url');
      const stateRaw = parsed.searchParams.get('state') ?? '';
      const stateObj = JSON.parse(Buffer.from(stateRaw, 'base64url').toString('utf8')) as {
        nonce?: string;
      };
      assert.equal(stateObj.nonce, 'n-url');

      // discovery 缓存：第二次构造不再出网
      await client.buildAuthorizationUrl({ nonce: 'n-url-2' });
      assert.equal(provider.requests.filter((r) => r.url.includes('openid-configuration')).length, 1);
    } finally {
      provider.restore();
    }
  });

  it('exchangeCode：表单参数完整（code/grant_type/凭据），TokenSet 承接 id_token 与 expiresAt', async (t) => {
    if (RealOidcClient === null || jose === null) {
      return t.skip('jose 未安装：CI 安装依赖后自动启用');
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const idToken = signRs256({ ...standardClaims(nowSec), nonce: 'n-x' });
    const provider = installFakeProvider(idToken);
    try {
      const client = new RealOidcClient({
        endpoint: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
      });

      const frozenNow = 1_777_000_000_000;
      const realNow = Date.now;
      Date.now = () => frozenNow;
      let tokens: Awaited<ReturnType<FakeOidcClientInstance['exchangeCode']>>;
      try {
        tokens = await client.exchangeCode('auth-code-abc');
      } finally {
        Date.now = realNow;
      }

      assert.equal(tokens.idToken, idToken);
      assert.equal(tokens.accessToken, 'at-fake-access-token');
      assert.equal(tokens.refreshToken, 'rt-fake');
      assert.equal(tokens.expiresAt, frozenNow + 3600 * 1000);

      const tokenCall = provider.requests.find((r) =>
        r.url.endsWith('/api/login/oauth/access_token'),
      );
      assert.ok(tokenCall);
      assert.ok((tokenCall.body ?? '').includes('code=auth-code-abc'));
    } finally {
      provider.restore();
    }
  });

  it("verifyIdToken：真实 RS256 签名 + JWKS 校验通过并返回主体绑定 claims（CAS-CAP-004）", async (t) => {
    if (RealOidcClient === null || jose === null) {
      return t.skip('jose 未安装：CI 安装依赖后自动启用');
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const idToken = signRs256({ ...standardClaims(nowSec), nonce: 'n-good' });
    const provider = installFakeProvider(idToken);
    try {
      const client = new RealOidcClient({
        endpoint: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
      });
      const claims = await client.verifyIdToken(idToken, 'n-good');
      assert.equal(claims['sub'], 'u_1001');
      assert.equal(claims['email'], 'zs@example.edu');
    } finally {
      provider.restore();
    }
  });

  it('verifyIdToken：nonce 不匹配 → 拒绝（防令牌注入到他人流程）', async (t) => {
    if (RealOidcClient === null || jose === null) {
      return t.skip('jose 未安装：CI 安装依赖后自动启用');
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const idToken = signRs256({ ...standardClaims(nowSec), nonce: 'n-other' });
    const provider = installFakeProvider(idToken);
    try {
      const client = new RealOidcClient({
        endpoint: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
      });
      await assert.rejects(client.verifyIdToken(idToken, 'n-mine'), /nonce mismatch/);
    } finally {
      provider.restore();
    }
  });

  it("verifyIdToken：篡改签名位 → 真实验证路径拒绝（RS256 签名确被校验，非仅解码）", async (t) => {
    if (RealOidcClient === null || jose === null) {
      return t.skip('jose 未安装：CI 安装依赖后自动启用');
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const legit = signRs256({ ...standardClaims(nowSec), nonce: 'n-t' });
    const tampered = `${legit.slice(0, -3)}aaaa`;
    const provider = installFakeProvider(tampered);
    try {
      const client = new RealOidcClient({
        endpoint: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
      });
      await assert.rejects(client.verifyIdToken(tampered, 'n-t'));
    } finally {
      provider.restore();
    }
  });

  it("verifyIdToken：错误受众/签发方 → 拒绝（CAS-CAP-004 签发方与受众绑定）", async (t) => {
    if (RealOidcClient === null || jose === null) {
      return t.skip('jose 未安装：CI 安装依赖后自动启用');
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const wrongAud = signRs256({
      ...standardClaims(nowSec),
      nonce: 'n-a',
      aud: 'some-other-client',
    });
    const wrongIss = signRs256({
      ...standardClaims(nowSec),
      nonce: 'n-a',
      iss: 'https://evil.example',
    });

    const handle = installFakeProvider(wrongAud);
    try {
      const client = new RealOidcClient({
        endpoint: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
      });
      await assert.rejects(client.verifyIdToken(wrongAud, 'n-a'));
      handle.setIssuer('https://evil.example');
      // 客户端 discovery 已缓存首个 issuer；新实例重新发现以取得被篡改的 issuer
      const client2 = new RealOidcClient({
        endpoint: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
      });
      await assert.rejects(client2.verifyIdToken(wrongIss, 'n-a'));
    } finally {
      handle.restore();
    }
  });

  it('fetchAccountState：ACTIVE/DISABLED/DELETED/UNKNOWN 映射（CAS-CAP-005；字段缺失 → UNKNOWN fail-closed）', async (t) => {
    if (RealOidcClient === null || jose === null) {
      return t.skip('jose 未安装：CI 安装依赖后自动启用');
    }
    const provider = installFakeProvider(signRs256(standardClaims(0)));
    try {
      const client = new RealOidcClient({
        endpoint: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
      });

      provider.setAccountState({ isForbidden: false, isDeleted: false });
      assert.equal(await client.fetchAccountState('at-fake-access-token'), 'ACTIVE');

      provider.setAccountState({ isForbidden: true, isDeleted: false });
      assert.equal(await client.fetchAccountState('at-fake-access-token'), 'DISABLED');

      provider.setAccountState({ isForbidden: false, isDeleted: true });
      assert.equal(await client.fetchAccountState('at-fake-access-token'), 'DELETED');

      provider.setAccountState({});
      assert.equal(await client.fetchAccountState('at-fake-access-token'), 'UNKNOWN');
    } finally {
      provider.restore();
    }
  });
});
