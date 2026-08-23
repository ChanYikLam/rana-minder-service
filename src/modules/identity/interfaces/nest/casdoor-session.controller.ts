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
 * 配置驱动：casdoor.endpoint/clientId/clientSecretRef 缺失时，登录/会话端点
 * 抛 SessionError(503 CAS-ERR-NOT_CONFIGURED)（fail-closed，不签发会话 JWT）；
 * 会话解析退回到 RejectAllAuthSessionProvider（受保护端点 401 IFC-ERR-001）。
 */

import { Controller, Delete, Get, HttpCode, HttpException, Inject } from '@nestjs/common';
import { type Request as ExpressRequest, type Response } from 'express';
import { RANA_MINDER_CONFIG, type RanaMinderConfig } from '../../../../config';
import { CasdoorOidcClient } from '../../../../platform/casdoor/infrastructure/casdoor-oidc-client';
import type {
  CasdoorOidcConfig,
  TokenSet,
} from '../../../../platform/casdoor/infrastructure/casdoor-oidc-client';
import { OidcAuthSessionProvider, type SessionClaims } from './oidc-session-provider';
import { deriveSessionSecret } from './session-secret';
import { CasdoorAvailability } from './casdoor-availability';
import { CASDOOR_AVAILABILITY } from '../../tokens';

/** Casdoor 账号状态（与 CasdoorOidcClient.fetchAccountState 返回值一致）。 */
type AccountState = 'ACTIVE' | 'DISABLED' | 'DELETED' | 'UNKNOWN';

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

  constructor(
    @Inject(RANA_MINDER_CONFIG) private readonly config: RanaMinderConfig,
    @Inject(CASDOOR_AVAILABILITY) private readonly availability: CasdoorAvailability,
  ) {}

  /** GET /api/auth/casdoor/login-url */
  @Get('casdoor/login-url')
  async getLoginUrl(_req: ExpressRequest): Promise<{ url: string }> {
    const client = this.ensureClient();
    const nonce = crypto.randomUUID();
    const state = { nonce };
    try {
      const url = await client.buildAuthorizationUrl(state);
      this.availability.markAvailable();
      return { url };
    } catch (error) {
      this.availability.markUnavailable();
      throw error;
    }
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

    // 解码 state → nonce
    let nonce: string;
    try {
      const state = JSON.parse(Buffer.from(stateRaw, 'base64url').toString('utf8'));
      nonce = state.nonce;
    } catch {
      throw new SessionError('Invalid state', 400);
    }

    // 交换授权码 → TokenSet（Casdoor 连通失败时标记降级窗口，CAS-FAIL-001）
    let tokens: TokenSet;
    try {
      tokens = await client.exchangeCode(code);
    } catch (error) {
      this.availability.markUnavailable();
      throw error;
    }
    if (!tokens.idToken) {
      throw new SessionError('Token exchange failed', 401);
    }

    // 验证 id_token（CAS-CAP-004：签发方/受众/有效期/主体绑定）
    const claims = await client.verifyIdToken(tokens.idToken, nonce);
    const sub = typeof claims['sub'] === 'string' ? claims['sub'] : '';
    if (!sub) {
      throw new SessionError('Invalid id_token: missing sub', 401);
    }

    // 检查账号状态（CAS-REC-002 实时读回；UNKNOWN fail-closed，不宣称有效）
    let accountState: AccountState;
    try {
      accountState = await client.fetchAccountState(tokens.accessToken);
    } catch (error) {
      this.availability.markUnavailable();
      throw error;
    }
    if (accountState === 'DISABLED' || accountState === 'DELETED' || accountState === 'UNKNOWN') {
      throw new SessionError('账号已被禁用/删除或状态不可确认', 403, 'IFC-ERR-011');
    }

    // Casdoor 链路整体可用（探测恢复）
    this.availability.markAvailable();

    // 签发本地会话 JWT
    const now = Math.floor(Date.now() / 1000);
    const sessionClaims: SessionClaims = {
      sub,
      name: typeof claims['name'] === 'string' ? claims['name'] : undefined,
      email: typeof claims['email'] === 'string' ? claims['email'] : undefined,
      iat: now,
      degraded: false,
    };
    const sessionToken = await OidcAuthSessionProvider.signSession(
      sessionClaims,
      this.sessionSecret!,
    );

    // Set-Cookie (HttpOnly, Secure 在 dev 环境不强制)
    res.setHeader('Set-Cookie', `session_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax`);

    return {
      user: {
        sub,
        name: (claims['name'] as string) ?? sub,
        email: claims['email'] as string | undefined,
      },
      profileGate: { profileComplete: true, emailVerified: false },
      degraded: false,
      degradedSince: null,
      permissions: [],
      workspace: null,
    };
  }

  /** DELETE /api/auth/logout */
  @Delete('logout')
  @HttpCode(200)
  async logout(_req: ExpressRequest, res: Response): Promise<{ ok: boolean }> {
    res.setHeader('Set-Cookie', 'session_token=; Path=/; Max-Age=0');
    return { ok: true };
  }

  // ----- 内部 -----

  private ensureClient(): CasdoorOidcClient {
    if (this.oidcClient) return this.oidcClient;
    const c = this.config.casdoor;
    if (!c.endpoint || !c.clientId || !c.clientSecretRef) {
      this.availability.markUnavailable();
      throw new SessionError(
        'Casdoor OIDC 未配置（endpoint/clientId/clientSecretRef 缺失）',
        503,
        'CAS-ERR-NOT_CONFIGURED',
      );
    }
    const oidcConfig: CasdoorOidcConfig = {
      endpoint: c.endpoint,
      clientId: c.clientId,
      clientSecret: c.clientSecretRef,
      redirectUri: c.redirectUri,
    };
    this.oidcClient = new CasdoorOidcClient(oidcConfig);
    this.sessionSecret = deriveSessionSecret(c.clientSecretRef);
    return this.oidcClient;
  }
}

export class SessionError extends HttpException {
  constructor(
    message: string,
    statusCode: number,
    public readonly code?: string,
  ) {
    super({ message, statusCode, ...(code ? { code } : {}) }, statusCode);
    this.name = 'SessionError';
  }
}
