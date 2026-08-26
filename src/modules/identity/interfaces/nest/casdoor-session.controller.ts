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
import { randomUUID } from 'node:crypto';
import { type Request as ExpressRequest, type Response } from 'express';
import {
  RANA_MINDER_CONFIG,
  isSecretRef,
  resolveSecret,
  type RanaMinderConfig,
} from '../../../../config';
import { CasdoorOidcClient } from '../../../../platform/casdoor/infrastructure/casdoor-oidc-client';
import type {
  CasdoorOidcConfig,
  TokenSet,
} from '../../../../platform/casdoor/infrastructure/casdoor-oidc-client';
import { OidcAuthSessionProvider, type SessionClaims } from './oidc-session-provider';
import { deriveSessionSecret } from './session-secret';
import { CasdoorAvailability } from './casdoor-availability';
import { InMemoryOidcNonceStore } from './oidc-nonce-store';
import { CASDOOR_AVAILABILITY, SESSION_REVOCATION_PORT } from '../../tokens';
import type { SessionRevocationPort } from '../../application/ports/session-revocation.port';

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
  private readonly nonceStore = new InMemoryOidcNonceStore();

  constructor(
    @Inject(RANA_MINDER_CONFIG) private readonly config: RanaMinderConfig,
    @Inject(CASDOOR_AVAILABILITY) private readonly availability: CasdoorAvailability,
    @Inject(SESSION_REVOCATION_PORT) private readonly revocationPort?: SessionRevocationPort,
  ) {}

  /** GET /api/auth/casdoor/login-url */
  @Get('casdoor/login-url')
  async getLoginUrl(_req: ExpressRequest): Promise<{ url: string }> {
    const client = this.ensureClient();
    const nonce = randomUUID();
    // 服务端记录本次授权请求的 nonce，回调时校验并一次性消费（登录 CSRF/会话固定防护）。
    this.nonceStore.issue(nonce);
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
    // 记录本次登录尝试开始前的 Casdoor 连通状态：若此前探测已判定不可用，则本次
    // 成功建立的会话仍标记为 degraded，受 CAS-FAIL-001 的 15 分钟降级窗口约束。
    const wasAvailable = this.availability.available;
    const code = req.query['code'] as string | undefined;
    const stateRaw = req.query['state'] as string | undefined;

    if (!code || !stateRaw) {
      throw new SessionError('Missing code or state', 400);
    }

    // 解码 state → nonce，并校验该 nonce 确由本服务签发（一次性消费）。
    // 未签发/已消费/过期一律拒绝，防登录 CSRF 与会话固定。
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

    // 签发本地会话 JWT。degraded 联动本次登录尝试开始前的 Casdoor 连通状态
    // （CAS-FAIL-001）：此前不可用时，本会话标记为 degraded，受 15 分钟降级窗口约束。
    const degraded = !wasAvailable;
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

    // profileGate 联动真实账号/声明（CAS-REC-002）：emailVerified 来自 id_token 声明，
    // profileComplete 依据核心资料字段是否齐备（name 与 email 均存在）。
    const email = typeof claims['email'] === 'string' ? claims['email'] : undefined;
    const name = (claims['name'] as string) ?? sub;
    const emailVerified = claims['email_verified'] === true;
    const profileComplete = Boolean(name && email);

    return {
      user: {
        sub,
        name,
        email,
      },
      profileGate: { profileComplete, emailVerified },
      degraded,
      degradedSince: degraded ? new Date(now * 1000).toISOString() : null,
      permissions: [],
      workspace: null,
    };
  }

  /** DELETE /api/auth/logout */
  @Delete('logout')
  @HttpCode(200)
  async logout(req: ExpressRequest, res: Response): Promise<{ ok: boolean }> {
    // BUG-007：登出时主动吊销该主体全部会话（不只清 Cookie）
    if (this.revocationPort) {
      const sub = this.extractSubjectFromRequest(req);
      if (sub) {
        try {
          await this.revocationPort.invalidateAllSessions(sub);
        } catch {
          // 吊销失败不阻断 Cookie 清除（客户端已不可信）
        }
      }
    }
    // 清 cookie 时使用与写入一致的 Path/HttpOnly/SameSite/Secure 属性，确保真正清除。
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const secureAttr = secure ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttr}`,
    );
    return { ok: true };
  }

  /** 从请求中提取 JWT subjectId（用于吊销；仅解码 payload 不验签） */
  private extractSubjectFromRequest(req: ExpressRequest): string | null {
    let token: string | null = null;
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      token = auth.slice(7);
    } else if (typeof req.headers['cookie'] === 'string') {
      const match = req.headers['cookie'].match(/(?:^|;\s*)session_token=([^;]+)/);
      if (match) token = match[1];
    }
    if (token === null) return null;
    try {
      const [, payloadB64] = token.split('.');
      if (!payloadB64) return null;
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
      return typeof payload['sub'] === 'string' ? payload['sub'] : null;
    } catch {
      return null;
    }
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
    const clientSecret = this.resolveClientSecret(c.clientSecretRef);
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

  /**
   * 解析 Casdoor clientSecret 引用为真实秘密（ADR-010）。引用串（如
   * ${env:...}）是公开常量，**禁止**直接作为 OIDC clientSecret 或会话派生
   * 输入（Critical：会话伪造 / token 交换失败）。
   */
  private resolveClientSecret(ref: string): string {
    return isSecretRef(ref) ? resolveSecret(ref) : ref;
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
