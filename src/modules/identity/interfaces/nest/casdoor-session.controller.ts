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

import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { type Request as ExpressRequest, type Response } from 'express';
import {
  isSecretRef,
  RANA_MINDER_CONFIG,
  resolveSecret,
  type RanaMinderConfig,
} from '../../../../config';
import { CasdoorOidcClient } from '../../../../platform/casdoor/infrastructure/casdoor-oidc-client';
import type { CasdoorOidcConfig } from '../../../../platform/casdoor/infrastructure/casdoor-oidc-client';
import { OidcAuthSessionProvider, type SessionClaims } from './oidc-session-provider';
import { resolveSessionSecret } from './session-secret';

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

  constructor(@Inject(RANA_MINDER_CONFIG) private readonly config: RanaMinderConfig) {}

  /** GET /api/auth/casdoor/login-url */
  @Get('casdoor/login-url')
  async getLoginUrl(_req: ExpressRequest, res: Response): Promise<{ url: string }> {
    const client = this.ensureClient();
    const nonce = crypto.randomUUID();
    const state = { nonce };
    const url = await client.buildAuthorizationUrl(state);
    // 登录 CSRF 防护（CAS-AUTH-003）：把完整 state 写入短生命周期 HttpOnly Cookie，
    // 回调时逐字符比对，杜绝攻击者把受害者的 code 绑定到自己的 state/nonce。
    const stateRaw = client.encodeState(state);
    res.setHeader(
      'Set-Cookie',
      `oidc_state=${stateRaw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_STATE_TTL_SECONDS}`,
    );
    return { url };
  }

  /** GET /api/auth/session?code=xxx&state=yyy */
  @Get('session')
  async establishSession(req: ExpressRequest, res: Response): Promise<SessionResponse> {
    const client = this.ensureClient();
    const code = req.query['code'] as string | undefined;
    const stateRaw = req.query['state'] as string | undefined;

    if (!code || !stateRaw) {
      throw new SessionError('Missing code or state', HttpStatus.BAD_REQUEST);
    }

    // 登录 CSRF 防护：回调 state 必须与 login-url 阶段下发的 HttpOnly Cookie 逐字节一致，
    // 否则拒绝（防 login CSRF / 回放）。比对失败按无效 state 处理，且清除残留 Cookie。
    const expectedState = readCookie(req, LOGIN_STATE_COOKIE);
    if (!expectedState || !timingSafeEqualStr(expectedState, stateRaw)) {
      res.setHeader(
        'Set-Cookie',
        `${LOGIN_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      );
      throw new SessionError('Invalid state', HttpStatus.BAD_REQUEST);
    }
    // 一次性使用：校验通过即清除，防同一 state 复用/回放。
    res.setHeader(
      'Set-Cookie',
      `${LOGIN_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    );

    // 解码 state → nonce
    let nonce: string;
    try {
      const state = JSON.parse(Buffer.from(stateRaw, 'base64url').toString('utf8'));
      nonce = state.nonce;
    } catch {
      throw new SessionError('Invalid state', HttpStatus.BAD_REQUEST);
    }

    // 交换授权码 → TokenSet
    const tokens = await client.exchangeCode(code);
    if (!tokens.idToken) {
      throw new SessionError('Token exchange failed', HttpStatus.UNAUTHORIZED);
    }

    // 验证 id_token（CAS-CAP-004：签发方/受众/有效期/主体绑定）
    const claims = await client.verifyIdToken(tokens.idToken, nonce);
    const sub = typeof claims['sub'] === 'string' ? claims['sub'] : '';
    if (!sub) {
      throw new SessionError('Invalid id_token: missing sub', HttpStatus.UNAUTHORIZED);
    }

    // 检查账号状态（CAS-REC-002 实时读回）
    const accountState = await client.fetchAccountState(tokens.accessToken);
    if (accountState === 'DISABLED' || accountState === 'DELETED') {
      throw new SessionError('账号已被禁用或删除', HttpStatus.FORBIDDEN, 'IFC-ERR-011');
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

    // Set-Cookie：HttpOnly + SameSite=Lax；生产/staging（非 dev/test）追加 Secure，
    // 避免非 HTTPS 链路窃听会话令牌（评审 SEC：Cookie 缺 Secure 标志）。
    res.setHeader(
      'Set-Cookie',
      `session_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax${isSecureEnv() ? '; Secure' : ''}`,
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
        HttpStatus.SERVICE_UNAVAILABLE,
        'CAS-ERR-NOT_CONFIGURED',
      );
    }
    // clientSecretRef 可能是明文或 ${env:...} 引用；仅对引用形式执行解析（ADR-010）。
    const clientSecret = isSecretRef(c.clientSecretRef)
      ? resolveSecret(c.clientSecretRef)
      : c.clientSecretRef;
    const oidcConfig: CasdoorOidcConfig = {
      endpoint: c.endpoint,
      clientId: c.clientId,
      clientSecret,
      redirectUri: c.redirectUri,
    };
    this.oidcClient = new CasdoorOidcClient(oidcConfig);
    // 会话签名密钥：优先独立 sessionSecretRef，否则从解析后的高熵 clientSecret 派生（CAS-AUTH-001）。
    this.sessionSecret = resolveSessionSecret(c);
    return this.oidcClient;
  }
}

/**
 * 会话端点错误（CAS-AUTH-001）。
 * 继承 HttpException 使 NestJS 内建异常处理按 statusCode 输出对应 HTTP 状态，
 * 而非落入 500（IFC-ERR-500 之外走 ApiErrorBody：code/message）。
 */
export class SessionError extends HttpException {
  constructor(
    message: string,
    statusCode: number,
    public readonly code?: string,
  ) {
    super(
      {
        code: code ?? 'IFC-ERR-001',
        message,
        supportId: '',
      },
      statusCode,
    );
    this.name = 'SessionError';
  }
}

// 登录 CSRF 防护常量（CAS-AUTH-003）：state 写入 HttpOnly Cookie，短生命周期防回放。
const LOGIN_STATE_COOKIE = 'oidc_state';
const LOGIN_STATE_TTL_SECONDS = 600;

/** 从请求 Cookie 头解析指定 cookie 值（避免依赖外部解析库）。 */
function readCookie(req: ExpressRequest, name: string): string | null {
  const header = req.headers['cookie'];
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === name) return decodeURIComponent(value);
  }
  return null;
}

/** 常量时间字符串比对（防时序侧信道，用于 state/nonce 回验）。 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** 会话 Cookie 是否需追加 Secure：仅 dev/test 不强制，其余环境（生产/staging/未设置）一律加。 */
function isSecureEnv(): boolean {
  const nodeEnv = process.env.NODE_ENV;
  return nodeEnv !== 'development' && nodeEnv !== 'test';
}
