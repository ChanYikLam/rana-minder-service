/**
 * Casdoor OIDC 客户端（infrastructure；CAS-CAP-004/007、CAS-REC-002）。
 *
 * 职责：OIDC 授权码流程——登录 URL 构造、code→token 交换、id_token 验证
 * （使用 jose 库验证 RS256 签名与 JWKS）、UserInfo 拉取。
 *
 * 设计决策：
 * - OIDC 发现（.well-known/openid-configuration）用于获取端点，不硬编码路径
 * - JWT 签名验证使用 jose 的 JWKS 远程密钥集（缓存 + 自动刷新），不信任裸令牌
 * - 会话令牌（本地 JWT）签名使用 HS256 + 本地秘密，不依赖 Casdoor
 * - 依赖 CASDOOR_CONFIG 注入（endpoint/clientId/clientSecretRef/redirectUri）；
 *   endpoint 为空时本客户端不实例化，走现有 RejectAll 桩
 *
 * 费用：新增 jose（MIT，DEP-003 已登记，兼容矩阵 DEP-002 已预见 Casdoor v3.108.0 × OIDC SDK）
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';

export interface CasdoorOidcConfig {
  readonly endpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export interface OidcState {
  readonly nonce: string;
  readonly redirectAfter?: string;
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

export class CasdoorOidcClient {
  private discovery?: OidcDiscovery;

  constructor(private readonly config: CasdoorOidcConfig) {}

  /**
   * 构造 Casdoor OIDC 授权码登录 URL（state 含 nonce 用于回验）。
   */
  async buildAuthorizationUrl(state: OidcState): Promise<string> {
    const disco = await this.ensureDiscovery();
    const url = new URL(disco.authorization_endpoint);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', this.encodeState(state));
    url.searchParams.set('nonce', state.nonce);
    return url.toString();
  }

  /**
   * 授权码 → TokenSet（含 id_token、access_token）。
   */
  async exchangeCode(code: string): Promise<TokenSet> {
    const disco = await this.ensureDiscovery();
    const res = await fetchWithTimeout(disco.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.config.redirectUri,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Casdoor token endpoint returned ${res.status}: ${body.slice(0, 200)}`);
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
    const JWKS = createRemoteJWKSet(new URL(disco.jwks_uri));
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
   * 经 access_token 调用 Casdoor /api/get-user 读取本人账号；isForbidden →
   * DISABLED，isDeleted → DELETED。字段缺失时返回 UNKNOWN（fail-closed，
   * 不宣称账号当前有效）。
   */
  async fetchAccountState(
    accessToken: string,
  ): Promise<'ACTIVE' | 'DISABLED' | 'DELETED' | 'UNKNOWN'> {
    const url = `${this.config.endpoint}/api/get-user`;
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Casdoor get-user returned ${res.status}`);
    }
    const body = (await res.json()) as { status?: string; data?: Record<string, unknown> };
    if (body.status !== 'ok' || !body.data) {
      throw new Error('Casdoor get-user returned non-ok status');
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

  // ----- 内部 -----

  private async ensureDiscovery(): Promise<OidcDiscovery> {
    if (this.discovery) return this.discovery;
    const url = `${this.config.endpoint}/.well-known/openid-configuration`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      throw new Error(`Casdoor OIDC discovery failed: ${res.status}`);
    }
    const doc = (await res.json()) as Record<string, unknown>;
    this.discovery = {
      issuer: String(doc['issuer'] ?? ''),
      authorization_endpoint: String(doc['authorization_endpoint'] ?? ''),
      token_endpoint: String(doc['token_endpoint'] ?? ''),
      userinfo_endpoint: String(doc['userinfo_endpoint'] ?? ''),
      jwks_uri: String(doc['jwks_uri'] ?? ''),
      end_session_endpoint:
        typeof doc['end_session_endpoint'] === 'string' ? doc['end_session_endpoint'] : undefined,
    };
    return this.discovery;
  }

  /** 编码 OIDC state（base64url JSON）。公开供控制器把 state 写入 HttpOnly Cookie 以做登录 CSRF 比对。 */
  encodeState(state: OidcState): string {
    return Buffer.from(JSON.stringify(state)).toString('base64url');
  }
}
