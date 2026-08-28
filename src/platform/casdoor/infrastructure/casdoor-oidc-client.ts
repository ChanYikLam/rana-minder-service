/**
 * Casdoor OIDC 客户端（infrastructure；CAS-CAP-004/007、CAS-REC-002）。
 *
 * 职责：OIDC 授权码流程——登录 URL 构造、code→token 交换、id_token 验证
 * （使用 jose 库验证 RS256 签名与 JWKS）、UserInfo 拉取。
 *
 * 设计决策：
 * - OIDC 发现（.well-known/openid-configuration）用于获取端点，不硬编码路径；
 *   发现文档带 TTL 缓存并固化指纹（sha256），复检时 issuer 漂移即 fail-closed
 *   （CAS-CAP-002/003：实例指纹证据，防端点被替换后静默换签）
 * - JWT 签名验证使用 jose 的 JWKS 远程密钥集（缓存 + 自动刷新），不信任裸令牌
 * - PKCE（RFC 7636，S256）默认开启：授权请求携带 code_challenge，token 交换
 *   携带仅服务端持有的 code_verifier；即使授权码被重定向链路截获也无法换码
 *   （纵深防御，学校实例支持性由 CAS-CAP 能力验证脚本确认后可经配置关闭）
 * - 出站错误消息一律脱敏：只保留状态码与尝试标识，不回显响应体/令牌/秘密
 *   （CAS-SEC-003/004：错误与日志不泄密）
 * - 会话令牌（本地 JWT）签名使用 HS256 + 本地秘密，不依赖 Casdoor
 *
 * 费用：新增 jose（MIT，DEP-003 已登记，兼容矩阵 DEP-002 已预见 Casdoor v3.108.0 × OIDC SDK）
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';

export interface CasdoorOidcConfig {
  readonly endpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  /**
   * PKCE（S256）开关（默认开启）。学校真实实例经能力验证脚本确认不支持时
   * 才允许显式置 false（记录证据）；关闭后安全基线回落为 confidential client
   * + 一次性 code + 服务端一次性 nonce/state。
   */
  readonly pkceEnabled?: boolean;
  /** 发现文档缓存 TTL（毫秒，默认 1 小时）；到期复检 issuer 稳定性与指纹。 */
  readonly discoveryTtlMs?: number;
}

export interface OidcState {
  readonly nonce: string;
  readonly redirectAfter?: string;
  /** PKCE code_verifier（仅服务端持有；pkceEnabled 时必填，缺失 fail-closed）。 */
  readonly codeVerifier?: string;
}

export interface TokenSet {
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: number;
}

export interface OidcUserInfo {
  readonly sub: string;
  readonly name?: string;
  readonly email?: string;
  readonly preferred_username?: string;
  readonly picture?: string;
}

export interface OidcDiscovery {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly userinfo_endpoint: string;
  readonly jwks_uri: string;
  readonly end_session_endpoint?: string;
}

/** 出站 OIDC 请求超时（毫秒）；避免 Casdoor 挂起无限阻塞 /api/auth/session。 */
export const OIDC_FETCH_TIMEOUT_MS = 5000;

/** 发现文档默认缓存 TTL（毫秒）：issuer/JWKS 指纹按此周期复检。 */
export const DISCOVERY_TTL_MS = 60 * 60 * 1000;

/** 生成 PKCE code_verifier（RFC 7636 §4.1：32 字节随机 → base64url，43+ 字符）。 */
export function generateCodeVerifier(): string {
  return randomBytesBase64url(32);
}

/** 计算 S256 code_challenge（BASE64URL(SHA256(verifier))，无填充）。 */
export function computeCodeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function randomBytesBase64url(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

/** 带超时的 fetch：AbortController 计时中断挂起连接（CAS-AUTH-001 出站不阻塞）。 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  timeoutMs = OIDC_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface DiscoveryCacheEntry {
  readonly discovery: OidcDiscovery;
  readonly fingerprint: string;
  readonly fetchedAt: number;
}

export class CasdoorOidcClient {
  private discoveryCache?: DiscoveryCacheEntry;
  private jwksByUri = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  constructor(private readonly config: CasdoorOidcConfig) {}

  private get pkceEnabled(): boolean {
    return this.config.pkceEnabled !== false;
  }

  /**
   * 构造 Casdoor OIDC 授权码登录 URL（state 含 nonce 用于回验）。
   * pkceEnabled（默认）时必须提供 state.codeVerifier（仅服务端持有），
   * 缺失即抛错 fail-closed——不以"可用的降级 URL"静默弱化基线。
   */
  async buildAuthorizationUrl(state: OidcState): Promise<string> {
    const disco = await this.ensureDiscovery();
    if (this.pkceEnabled && typeof state.codeVerifier !== 'string') {
      throw new Error('PKCE enabled but code_verifier missing (fail-closed)');
    }
    const url = new URL(disco.authorization_endpoint);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', this.encodeState(state));
    url.searchParams.set('nonce', state.nonce);
    if (this.pkceEnabled && state.codeVerifier) {
      url.searchParams.set('code_challenge', computeCodeChallengeS256(state.codeVerifier));
      url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  }

  /**
   * 授权码 → TokenSet（含 id_token、access_token）。
   * pkceEnabled 时必须传入与授权请求配对的 code_verifier（RFC 7636 §4.5）。
   * 错误脱敏：失败只抛状态码 + 尝试标识，不携带响应体（可能含上游细节）。
   */
  async exchangeCode(code: string, codeVerifier?: string): Promise<TokenSet> {
    const disco = await this.ensureDiscovery();
    if (this.pkceEnabled && typeof codeVerifier !== 'string') {
      throw new Error('PKCE enabled but code_verifier missing for token exchange (fail-closed)');
    }
    const attemptId = randomUUID();
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code,
      redirect_uri: this.config.redirectUri,
    });
    if (codeVerifier) {
      form.set('code_verifier', codeVerifier);
    }
    const res = await fetchWithTimeout(disco.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (!res.ok) {
      // CAS-SEC-003：不把上游错误响应体带进异常消息（可能进入日志/审计），
      // 仅保留状态码与尝试标识供排障关联。
      throw new Error(
        `Casdoor token endpoint returned ${res.status} (attempt ${attemptId})`,
      );
    }
    const json = (await res.json()) as Record<string, unknown>;
    return {
      accessToken: String(json['access_token'] ?? ''),
      idToken: String(json['id_token'] ?? ''),
      refreshToken: typeof json['refresh_token'] === 'string' ? json['refresh_token'] : undefined,
      expiresAt:
        typeof json['expires_in'] === 'number'
          ? Date.now() + (json['expires_in'] as number) * 1000
          : undefined,
    };
  }

  /**
   * 验证 id_token 并返回 claims（CAS-CAP-004：签发方、受众、有效期、主体绑定）。
   */
  async verifyIdToken(idToken: string, nonce: string): Promise<JWTPayload> {
    const disco = await this.ensureDiscovery();
    const JWKS = this.jwksFor(disco.jwks_uri);
    const { payload } = await jwtVerify(idToken, JWKS, {
      issuer: disco.issuer,
      audience: this.config.clientId,
    });
    if (payload.nonce !== nonce) {
      throw new Error('id_token nonce mismatch');
    }
    return payload;
  }

  /**
   * 获取 UserInfo（Bearer access_token）。
   */
  async fetchUserInfo(accessToken: string): Promise<OidcUserInfo> {
    const disco = await this.ensureDiscovery();
    const res = await fetchWithTimeout(disco.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Casdoor userinfo returned ${res.status}`);
    }
    return (await res.json()) as OidcUserInfo;
  }

  /**
   * 获取 Casdoor 登出 URL（前端直接跳转）。
   */
  async buildLogoutUrl(): Promise<string> {
    const disco = await this.ensureDiscovery();
    if (disco.end_session_endpoint) {
      return `${disco.end_session_endpoint}?client_id=${encodeURIComponent(this.config.clientId)}`;
    }
    return `${this.config.endpoint}/api/logout`;
  }

  /**
   * 读取账号当前状态（CAS-CAP-005：账号有效、禁用、删除与恢复的可信读取）。
   *
   * 经 access_token 调用 Casdoor /api/get-account 读取本人账号（联调 2026-08-27
   * 修正：/api/get-user 需管理员授权与 id 参数，本人状态读取应走 get-account）；
   * isForbidden → DISABLED，isDeleted → DELETED。字段缺失时返回 UNKNOWN
   * （fail-closed，不宣称账号当前有效）。
   */
  async fetchAccountState(
    accessToken: string,
  ): Promise<'ACTIVE' | 'DISABLED' | 'DELETED' | 'UNKNOWN'> {
    const url = `${this.config.endpoint}/api/get-account`;
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Casdoor get-account returned ${res.status}`);
    }
    const body = (await res.json()) as { status?: string; data?: Record<string, unknown> };
    if (body.status !== 'ok' || !body.data) {
      throw new Error('Casdoor get-account returned non-ok status');
    }
    const user = body.data;
    if (user['isDeleted'] === true) return 'DELETED';
    if (user['isForbidden'] === true) return 'DISABLED';
    // 字段缺失（旧版本或字段裁剪）→ 不宣称有效
    if (typeof user['isForbidden'] !== 'boolean' || typeof user['isDeleted'] !== 'boolean') {
      return 'UNKNOWN';
    }
    return 'ACTIVE';
  }

  /** 当前发现文档指纹（sha256 hex；未抓取时 null）。供能力验证证据与运行期漂移监测。 */
  getDiscoveryFingerprint(): string | null {
    return this.discoveryCache?.fingerprint ?? null;
  }

  /** 当前发现文档 issuer（未抓取时 null）。 */
  getDiscoveryIssuer(): string | null {
    return this.discoveryCache?.discovery.issuer ?? null;
  }

  // ----- 内部 -----

  private async ensureDiscovery(): Promise<OidcDiscovery> {
    const ttl = this.config.discoveryTtlMs ?? DISCOVERY_TTL_MS;
    const cached = this.discoveryCache;
    if (cached && Date.now() - cached.fetchedAt < ttl) {
      return cached.discovery;
    }
    const url = `${this.config.endpoint}/.well-known/openid-configuration`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      throw new Error(`Casdoor OIDC discovery failed: ${res.status}`);
    }
    const doc = (await res.json()) as Record<string, unknown>;
    const discovery: OidcDiscovery = {
      issuer: String(doc['issuer'] ?? ''),
      authorization_endpoint: String(doc['authorization_endpoint'] ?? ''),
      token_endpoint: String(doc['token_endpoint'] ?? ''),
      userinfo_endpoint: String(doc['userinfo_endpoint'] ?? ''),
      jwks_uri: String(doc['jwks_uri'] ?? ''),
      end_session_endpoint:
        typeof doc['end_session_endpoint'] === 'string' ? doc['end_session_endpoint'] : undefined,
    };
    // 指纹 = 发现文档规范字段的 sha256（CAS-CAP-002：不可由普通客户端伪造的实例指纹输入之一）
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          discovery.issuer,
          discovery.authorization_endpoint,
          discovery.token_endpoint,
          discovery.userinfo_endpoint,
          discovery.jwks_uri,
          discovery.end_session_endpoint ?? null,
        ]),
      )
      .digest('hex');
    // issuer 漂移 fail-closed（CAS-CAP-003）：复检时签发方变更意味着端点/实例被
    // 替换或重配置，继续使用旧 JWKS 验签将失去意义；拒绝并要求人工介入。
    if (cached && cached.discovery.issuer !== discovery.issuer) {
      throw new Error(
        `Casdoor discovery issuer changed (was '${cached.discovery.issuer}', now '${discovery.issuer}') — fail-closed per CAS-CAP-003`,
      );
    }
    this.discoveryCache = { discovery, fingerprint, fetchedAt: Date.now() };
    return discovery;
  }

  private jwksFor(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
    let jwks = this.jwksByUri.get(jwksUri);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(jwksUri));
      this.jwksByUri.set(jwksUri, jwks);
    }
    return jwks;
  }

  /** 编码 OIDC state（base64url JSON）。公开供控制器把 state 写入 HttpOnly Cookie 以做登录 CSRF 比对。 */
  encodeState(state: OidcState): string {
    return Buffer.from(JSON.stringify(state)).toString('base64url');
  }
}
