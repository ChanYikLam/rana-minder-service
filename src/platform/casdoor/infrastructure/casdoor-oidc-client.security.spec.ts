/**
 * CasdoorOidcClient 安全加固测试（PKCE / 错误脱敏 / discovery 固化）。
 *
 * 校验（2026-08-28 接学校真实实例前加固）：
 * - PKCE S256：授权 URL 携带 code_challenge(S256) 与 method=S256；verifier 缺失
 *   fail-closed；换码请求携带 code_verifier；
 * - 错误脱敏：token 端点失败消息不含上游响应体（CAS-SEC-003）；
 * - discovery：TTL 内复用缓存；指纹可取；issuer 漂移 fail-closed（CAS-CAP-003）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  CasdoorOidcClient,
  computeCodeChallengeS256,
  generateCodeVerifier,
} from './casdoor-oidc-client';

const DISCOVERY = {
  issuer: 'https://casdoor.test',
  authorization_endpoint: 'https://casdoor.test/login/oauth/authorize',
  token_endpoint: 'https://casdoor.test/api/login/oauth/access_token',
  userinfo_endpoint: 'https://casdoor.test/api/userinfo',
  jwks_uri: 'https://casdoor.test/.well-known/jwks',
  end_session_endpoint: 'https://casdoor.test/api/logout',
};

const baseConfig = {
  endpoint: 'https://casdoor.test',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://app.test/callback',
};

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** 可编程 fetch 桩：按 URL 正则路由响应，并记录全部调用 */
function makeFetch(routes: Array<{ match: RegExp; respond: () => Response }>) {
  const calls: FetchCall[] = [];
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const route = routes.find((r) => r.match.test(url));
    if (!route) {
      return new Response('not found', { status: 404 });
    }
    return route.respond();
  }) as typeof fetch;
  return { calls, fn };
}

function withFetch(fn: typeof fetch, body: () => Promise<void>): Promise<void> {
  return (async () => {
    const original = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      await body();
    } finally {
      globalThis.fetch = original;
    }
  })();
}

describe('CasdoorOidcClient PKCE（S256，默认开启）', () => {
  it('授权 URL 携带 code_challenge(S256) 与 method=S256，不携带 verifier', async () => {
    const { calls, fn } = makeFetch([
      { match: /openid-configuration/, respond: () => Response.json(DISCOVERY) },
    ]);
    await withFetch(fn, async () => {
      const client = new CasdoorOidcClient(baseConfig);
      const verifier = generateCodeVerifier();
      const url = await client.buildAuthorizationUrl({ nonce: 'n-1', codeVerifier: verifier });
      const parsed = new URL(url);
      const expected = computeCodeChallengeS256(verifier);
      assert.equal(parsed.searchParams.get('code_challenge'), expected);
      assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(parsed.searchParams.get('code_verifier'), null, 'verifier 绝不出现在授权 URL');
      assert.ok(verifier.length >= 43, 'RFC 7636：verifier 至少 43 字符');
      assert.equal(calls.length, 1, '仅发现文档请求');
    });
  });

  it('PKCE 开启但缺 verifier → 构造授权 URL 抛错（fail-closed）', async () => {
    const { fn } = makeFetch([
      { match: /openid-configuration/, respond: () => Response.json(DISCOVERY) },
    ]);
    await withFetch(fn, async () => {
      const client = new CasdoorOidcClient(baseConfig);
      await assert.rejects(client.buildAuthorizationUrl({ nonce: 'n-1' }), /code_verifier missing/);
    });
  });

  it('PKCE 开启但缺 verifier → 换码抛错（fail-closed，不发网络请求）', async () => {
    const { calls, fn } = makeFetch([
      { match: /openid-configuration/, respond: () => Response.json(DISCOVERY) },
    ]);
    await withFetch(fn, async () => {
      const client = new CasdoorOidcClient(baseConfig);
      await assert.rejects(client.exchangeCode('auth-code'), /code_verifier missing/);
      const tokenCalls = calls.filter((c) => /access_token/.test(c.url));
      assert.equal(tokenCalls.length, 0, 'fail-closed 检查先于网络请求');
    });
  });

  it('换码请求携带 code_verifier（与授权请求的 challenge 配对）', async () => {
    const { calls, fn } = makeFetch([
      { match: /openid-configuration/, respond: () => Response.json(DISCOVERY) },
      {
        match: /access_token/,
        respond: () => Response.json({ access_token: 'at', id_token: 'it', expires_in: 3600 }),
      },
    ]);
    await withFetch(fn, async () => {
      const client = new CasdoorOidcClient(baseConfig);
      const verifier = generateCodeVerifier();
      const tokens = await client.exchangeCode('auth-code', verifier);
      assert.equal(tokens.accessToken, 'at');
      const tokenCall = calls.find((c) => /access_token/.test(c.url));
      assert.ok(tokenCall, '应发起换码请求');
      const form = String(tokenCall.init.body);
      const params = new URLSearchParams(form);
      assert.equal(params.get('code_verifier'), verifier, '换码必须携带 verifier');
      assert.equal(params.get('grant_type'), 'authorization_code');
    });
  });

  it('PKCE 关闭（能力验证证据支持）：授权 URL 不要求 challenge，换码不要求 verifier', async () => {
    const { calls, fn } = makeFetch([
      { match: /openid-configuration/, respond: () => Response.json(DISCOVERY) },
      {
        match: /access_token/,
        respond: () => Response.json({ access_token: 'at', id_token: 'it' }),
      },
    ]);
    await withFetch(fn, async () => {
      const client = new CasdoorOidcClient({ ...baseConfig, pkceEnabled: false });
      const url = await client.buildAuthorizationUrl({ nonce: 'n-2' });
      assert.equal(new URL(url).searchParams.get('code_challenge'), null);
      const tokens = await client.exchangeCode('auth-code');
      assert.equal(tokens.idToken, 'it');
      const tokenCall = calls.find((c) => /access_token/.test(c.url));
      const params = new URLSearchParams(String(tokenCall?.init.body));
      assert.equal(params.get('code_verifier'), null, '关闭时不得携带 verifier');
    });
  });
});

describe('CasdoorOidcClient 错误脱敏（CAS-SEC-003）', () => {
  it('token 端点失败：异常消息不含上游响应体（只含状态码与尝试标识）', async () => {
    const { fn } = makeFetch([
      { match: /openid-configuration/, respond: () => Response.json(DISCOVERY) },
      {
        match: /access_token/,
        respond: () =>
          Response.json(
            { error: 'invalid_grant', error_description: 'secret-ish detail access_token=xyz' },
            { status: 400 },
          ),
      },
    ]);
    await withFetch(fn, async () => {
      const client = new CasdoorOidcClient(baseConfig);
      const err = await client.exchangeCode('code-1', 'verifier-1').then(
        () => null,
        (e: unknown) => e as Error,
      );
      assert.ok(err instanceof Error);
      assert.doesNotMatch(
        err.message,
        /invalid_grant|access_token=xyz|secret-ish/,
        '响应体不得泄漏进异常消息',
      );
      assert.match(err.message, /returned 400/);
      assert.match(err.message, /attempt [0-9a-f-]{36}/, '尝试标识可关联排障');
    });
  });
});

describe('CasdoorOidcClient discovery 固化（CAS-CAP-002/003）', () => {
  it('TTL 内复用缓存（不重复请求），指纹与 issuer 可取', async () => {
    const { calls, fn } = makeFetch([
      { match: /openid-configuration/, respond: () => Response.json(DISCOVERY) },
    ]);
    await withFetch(fn, async () => {
      const client = new CasdoorOidcClient({ ...baseConfig, discoveryTtlMs: 60_000 });
      await client.buildAuthorizationUrl({ nonce: 'n', codeVerifier: generateCodeVerifier() });
      await client.buildAuthorizationUrl({ nonce: 'n', codeVerifier: generateCodeVerifier() });
      assert.equal(calls.length, 1, 'TTL 内仅抓取一次');
      const fingerprint = client.getDiscoveryFingerprint();
      assert.match(fingerprint ?? '', /^[0-9a-f]{64}$/, '指纹为 sha256 hex');
      assert.equal(client.getDiscoveryIssuer(), DISCOVERY.issuer);
      const expected = createHash('sha256')
        .update(
          JSON.stringify([
            DISCOVERY.issuer,
            DISCOVERY.authorization_endpoint,
            DISCOVERY.token_endpoint,
            DISCOVERY.userinfo_endpoint,
            DISCOVERY.jwks_uri,
            DISCOVERY.end_session_endpoint,
          ]),
        )
        .digest('hex');
      assert.equal(fingerprint, expected);
    });
  });

  it('TTL 过期复检：issuer 漂移 → fail-closed 抛错', async () => {
    let respondDrifted = false;
    const { fn } = makeFetch([
      {
        match: /openid-configuration/,
        respond: () =>
          respondDrifted
            ? Response.json({ ...DISCOVERY, issuer: 'https://evil.example' })
            : Response.json(DISCOVERY),
      },
    ]);
    await withFetch(fn, async () => {
      const client = new CasdoorOidcClient({ ...baseConfig, discoveryTtlMs: 1 });
      await client.buildAuthorizationUrl({ nonce: 'n', codeVerifier: generateCodeVerifier() });
      respondDrifted = true;
      await new Promise((resolve) => setTimeout(resolve, 5)); // 越过 1ms TTL
      await assert.rejects(
        client.buildAuthorizationUrl({ nonce: 'n', codeVerifier: generateCodeVerifier() }),
        /issuer changed/,
        '签发方漂移必须拒绝，不得静默换签',
      );
    });
  });

  it('TTL 过期复检：issuer 稳定时正常刷新缓存', async () => {
    let fetchCount = 0;
    const { fn } = makeFetch([
      {
        match: /openid-configuration/,
        respond: () => {
          fetchCount += 1;
          return Response.json(DISCOVERY);
        },
      },
    ]);
    await withFetch(fn, async () => {
      const client = new CasdoorOidcClient({ ...baseConfig, discoveryTtlMs: 1 });
      await client.buildAuthorizationUrl({ nonce: 'n', codeVerifier: generateCodeVerifier() });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await client.buildAuthorizationUrl({ nonce: 'n', codeVerifier: generateCodeVerifier() });
      assert.equal(fetchCount, 2, 'TTL 过期后复检一次');
      assert.equal(client.getDiscoveryIssuer(), DISCOVERY.issuer);
    });
  });
});
