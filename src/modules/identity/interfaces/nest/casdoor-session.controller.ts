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
 */

import { Controller, Delete, Get, HttpCode, Inject, Req, Res } from '@nestjs/common';
import { type Request as ExpressRequest, type Response } from 'express';
import { createHash } from 'node:crypto';
import { RANA_MINDER_CONFIG, type RanaMinderConfig } from '../../../../config';
import { CasdoorOidcClient } from '../../../../platform/casdoor/infrastructure/casdoor-oidc-client';
import type { CasdoorOidcConfig } from '../../../../platform/casdoor/infrastructure/casdoor-oidc-client';
import {
  OidcAuthSessionProvider,
  type SessionClaims,
} from './oidc-session-provider';

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
  ) {}

  /** GET /api/auth/casdoor/login-url */
  @Get('casdoor/login-url')
  async getLoginUrl(req: ExpressRequest): Promise<{ url: string }> {
    const client = this.ensureClient();
    const nonce = crypto.randomUUID();
    const state = { nonce };
    const url = await client.buildAuthorizationUrl(state);
    return { url };
  }

  /** GET /api/auth/session?code=xxx&state=yyy */
  @Get('session')
  async establishSession(
    req: ExpressRequest,
    res: Response,
  ): Promise<SessionResponse> {
    const client = this.ensureClient();
    const code = req.query['code'] as string | undefined;
    const stateRaw = req.query['state'] as string | undefined;

    if (!code || !stateRaw) {
      throw new SessionError('Missing code or state', 400);
    }

    // 解码 state → nonce
    let nonce: string;
    try {
      const state = JSON.parse(
        Buffer.from(stateRaw, 'base64url').toString('utf8'),
      );
      nonce = state.nonce;
    } catch {
      throw new SessionError('Invalid state', 400);
    }

    // 交换授权码 → TokenSet
    const tokens = await client.exchangeCode(code);
    if (!tokens.idToken) {
      throw new SessionError('Token exchange failed', 401);
    }

    // 验证 id_token（CAS-CAP-004：签发方/受众/有效期/主体绑定）
    const claims = await client.verifyIdToken(tokens.idToken, nonce);
    const sub = typeof claims['sub'] === 'string' ? claims['sub'] : '';
    if (!sub) {
      throw new SessionError('Invalid id_token: missing sub', 401);
    }

    // 检查账号状态（CAS-REC-002 实时读回）
    const accountState = await client.fetchAccountState(tokens.accessToken);
    if (accountState === 'DISABLED' || accountState === 'DELETED') {
      throw new SessionError('账号已被禁用或删除', 403, 'IFC-ERR-011');
    }

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
    res.setHeader(
      'Set-Cookie',
      `session_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax`,
    );

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
    this.sessionSecret = new TextEncoder().encode(
      createHash('sha256')
        .update(`ranaminder-session:${c.clientSecretRef}`)
        .digest('hex'),
    );
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