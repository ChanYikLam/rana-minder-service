/**
 * Casdoor OIDC 会话端点（interfaces/nest；API-AUTH-001）。
 *
 * 三端点：
 * - GET  /api/auth/casdoor/login-url   → 构造 Casdoor OIDC 授权码登录 URL
 * - GET  /api/auth/session             → OIDC 回调后建立会话，返回 session 数据
 * - DELETE /api/auth/logout            → 退出登录
 *
 * 端点不加 @UseGuards(AuthGuard)（会话建立前无认证主体）。
 * 会话 JWT 以 Set-Cookie 和 JSON body 双通道返回。
 *
 * 配置驱动：casdoor.endpoint 为空时本控制器不出现在路由表中（模块不注册），
 * 会话解析退回到 RejectAllAuthSessionProvider（fail-closed）。
 *
 * 密钥处理（ADR-010）：clientSecretRef 先经 resolveCasdoorClientSecret 解析为
 * 明文，再用于 OIDC client_secret 与派生会话 HMAC 密钥（单点化，见
 * session-security.ts，避免引用串直接当密钥导致的低熵可预测）。
 */

import { Controller, Delete, Get, HttpCode, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { type Request as ExpressRequest, type Response } from 'express';
import { RANA_MINDER_CONFIG, type RanaMinderConfig } from '../../../../config';
import { CasdoorOidcClient } from '../../../../platform/casdoor/infrastructure/casdoor-oidc-client';
import type { CasdoorOidcConfig } from '../../../../platform/casdoor/infrastructure/casdoor-oidc-client';
import { OidcAuthSessionProvider, type SessionClaims } from './oidc-session-provider';
import { CasdoorAvailabilityTracker } from './casdoor-availability-tracker';
import { InMemoryOidcNonceStore } from './oidc-nonce-store';
import { resolveCasdoorClientSecret, deriveSessionSecret } from './session-security';

/** GET /api/auth/session 响应（API-AUTH-001） */
export interface SessionResponse {
  user: {
    sub: string;
    name: string;
    email?: string;
  };
  profileGate: {
    profileComplete: boolean;
    emailVerified: boolean;
  };
  degraded: boolean;
  degradedSince: string | null;
  permissions: string[];
  workspace: {
    clubs: Array<{ id: string; name: string; role: string }>;
  } | null;
}

@Controller('api/auth')
export class CasdoorSessionController {
  private oidcClient?: CasdoorOidcClient;
  private sessionSecret?: Uint8Array;
  private readonly nonceStore = new InMemoryOidcNonceStore();

  constructor(
    @Inject(RANA_MINDER_CONFIG) private readonly config: RanaMinderConfig,
    private readonly availabilityTracker: CasdoorAvailabilityTracker,
  ) {}

  /** GET /api/auth/casdoor/login-url */
  @Get('casdoor/login-url')
  async getLoginUrl(_req: ExpressRequest): Promise<{ url: string }> {
    const client = this.ensureClient();
    const nonce = randomUUID();
    // 服务端记录本次授权请求的 nonce，回调时校验并一次性消费（登录 CSRF/会话固定防护）。
    this.nonceStore.issue(nonce);
    const state = { nonce };
    const url = await client.buildAuthorizationUrl(state);
    return { url };
  }

  /** GET /api/auth/session?code=xxx&state=yyy */
  @Get('session')
  async establishSession(req: ExpressRequest, res: Response): Promise<SessionResponse> {
    const client = this.ensureClient();
    const code = req.query['code'] as string | undefined;
    const stateRaw = req.query['state'] as string | undefined;

    if (!code || !stateRaw) {
      throw new SessionError('Missing code or state', 400);
    }

    // 解码 state → nonce，并校验该 nonce 确由本服务签发（一次性消费）。
    // 未签发/已消费/过期一律拒绝，防登录 CSRF 与会话固定（CAS-CAP-004）。
    let nonce: string;
    try {
      const state = JSON.parse(Buffer.from(stateRaw, 'base64url').toString('utf8'));
      nonce = state.nonce;
    } catch {
      throw new SessionError('Invalid state', 400);
    }
    if (typeof nonce !== 'string' || !this.nonceStore.consume(nonce)) {
      throw new SessionError('Invalid or expired state (nonce not issued by this service)', 400);
    }

    // 交换授权码 → TokenSet
    const tokens = await client.exchangeCode(code);
    if (!tokens.idToken) {
      throw new SessionError('Token exchange failed', 401);
    }
    // token 交换成功 → Casdoor 可达
    this.availabilityTracker.setAvailable(true);

    // 验证 id_token（CAS-CAP-004：签发方/受众/有效期/主体绑定）
    const claims = await client.verifyIdToken(tokens.idToken, nonce);
    const sub = typeof claims['sub'] === 'string' ? claims['sub'] : '';
    if (!sub) {
      throw new SessionError('Invalid id_token: missing sub', 401);
    }

    // 检查账号状态（CAS-REC-002 实时读回）；Casdoor 不可达时降级签发。
    let degraded = false;
    let degradedSince: string | null = null;
    try {
      const accountState = await client.fetchAccountState(tokens.accessToken);
      // UNKNOWN fail-closed（CAS-CAP-005）：字段缺失时不宣称账号有效，拒绝建立会话。
      if (accountState === 'DISABLED' || accountState === 'DELETED' || accountState === 'UNKNOWN') {
        throw new SessionError('账号已被禁用/删除或状态不可确认', 403, 'IFC-ERR-011');
      }
    } catch (err) {
      // 账号确认为禁用/删除/不可确认 → 403（rethrow 保持语义）
      if (err instanceof SessionError) {
        throw err;
      }
      // 其余异常视为 Casdoor 不可达：降级签发（CAS-FAIL-001），并标记不可用。
      this.availabilityTracker.setAvailable(false);
      degraded = true;
      degradedSince = new Date().toISOString();
    }

    // 签发本地会话 JWT
    const now = Math.floor(Date.now() / 1000);
    const sessionClaims: SessionClaims = {
      sub,
      name: typeof claims['name'] === 'string' ? claims['name'] : undefined,
      email: typeof claims['email'] === 'string' ? claims['email'] : undefined,
      iat: now,
      degraded,
    };
    const sessionToken = await OidcAuthSessionProvider.signSession(
      sessionClaims,
      this.sessionSecret!,
    );

    // Set-Cookie：HttpOnly + SameSite=Lax 强制；Secure 在 HTTPS 下启用（防明文截获）。
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const secureAttr = secure ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `session_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax${secureAttr}`,
    );

    return {
      user: {
        sub,
        name: (claims['name'] as string) ?? sub,
        email: claims['email'] as string | undefined,
      },
      profileGate: { profileComplete: true, emailVerified: false },
      degraded,
      degradedSince,
      permissions: [],
      workspace: null,
    };
  }

  /** DELETE /api/auth/logout */
  @Delete('logout')
  @HttpCode(200)
  async logout(req: ExpressRequest, res: Response): Promise<{ ok: boolean }> {
    // 清 cookie 时使用与写入一致的 Path/HttpOnly/SameSite/Secure 属性，确保真正清除。
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const secureAttr = secure ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `session_token=; Path=/; HttpOnly; SameSite=Lax${secureAttr}; Max-Age=0`,
    );
    return { ok: true };
  }

  // ----- 内部 -----

  private ensureClient(): CasdoorOidcClient {
    if (this.oidcClient) return this.oidcClient;
    const c = this.config.casdoor;
    if (!c.endpoint || !c.clientId || !c.clientSecretRef) {
      throw new SessionError(
        'Casdoor OIDC 未配置（endpoint/clientId/clientSecretRef 缺失）',
        503,
        'CAS-ERR-NOT_CONFIGURED',
      );
    }
    // ADR-010：先解析引用为明文，再用于 OIDC client_secret 与密钥派生（单点化）。
    const clientSecret = resolveCasdoorClientSecret(c.clientSecretRef);
    const oidcConfig: CasdoorOidcConfig = {
      endpoint: c.endpoint,
      clientId: c.clientId,
      clientSecret,
      redirectUri: c.redirectUri,
    };
    this.oidcClient = new CasdoorOidcClient(oidcConfig);
    this.sessionSecret = deriveSessionSecret(clientSecret);
    return this.oidcClient;
  }
}

export class SessionError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}
