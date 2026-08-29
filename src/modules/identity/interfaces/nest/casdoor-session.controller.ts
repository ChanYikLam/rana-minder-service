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
 * 安全基线（接学校真实实例前加固，2026-08-28）：
 * - PKCE（S256）默认开启：verifier 仅服务端持有（随 nonce 入共享存储，B3 修复），
 *   授权 URL/state/Cookie 均不携带（RFC 7636）；
 * - login-url / session 匿名端点按来源 IP + 全局双桶限流（auth-rate-limiter）；
 * - Cookie 强制 HttpOnly + SameSite=Lax；Secure 由 cookieSecureEnforced 配置强制
 *   或 HTTPS 探测；Max-Age 与会话 JWT 有效期对齐；
 * - 生产（NODE_ENV=production）或 requireDedicatedSessionSecret=true 时必须配置
 *   专用会话密钥（≥32 字符），否则会话链路 fail-closed（503）；
 * - 错误响应仅含安全分类码，不回显上游令牌/响应体（CAS-SEC-003/004）。
 *
 * 配置驱动：casdoor.endpoint/clientId/clientSecretRef 缺失时，登录/会话端点
 * 抛 SessionError(503 CAS-ERR-NOT_CONFIGURED)（fail-closed，不签发会话 JWT）；
 * 会话解析退回到 RejectAllAuthSessionProvider（受保护端点 401 IFC-ERR-001）。
 */

import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Optional,
  Req,
  Res,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { type Request as ExpressRequest, type Response } from 'express';
import { jwtVerify } from 'jose';
import {
  RANA_MINDER_CONFIG,
  isSecretRef,
  resolveSecret,
  type RanaMinderConfig,
} from '../../../../config';
import { IdentityUnitOfWork } from '../../infrastructure/unit-of-work';
import {
  CasdoorOidcClient,
  generateCodeVerifier,
} from '../../../../platform/casdoor/infrastructure/casdoor-oidc-client';
import type {
  CasdoorOidcConfig,
  TokenSet,
} from '../../../../platform/casdoor/infrastructure/casdoor-oidc-client';
import { OidcAuthSessionProvider, type SessionClaims } from './oidc-session-provider';
import { deriveSessionSecret } from './session-secret';
import { CasdoorAvailability } from './casdoor-availability';
import { InMemoryOidcNonceStore } from './oidc-nonce-store';
import { AuthRateLimiter } from './auth-rate-limiter';
import { secureFromRequest } from './secure-request';
import {
  CASDOOR_AVAILABILITY,
  SESSION_REVOCATION_PORT,
  SESSION_IDENTITY_REPOSITORY,
  ACCOUNT_ACCESS_CONTROLLER,
  OIDC_NONCE_STORE,
  SESSION_AUTHZ_QUERY,
} from '../../tokens';
import type { SessionRevocationPort } from '../../application/ports/session-revocation.port';
import type { SessionIdentitySnapshot } from '../../infrastructure/postgres-session-identity.repository';
import type { AccountAccessController } from '../controllers/account-access.controller';
import { sessionContractFromViews, type SessionResponseContract } from './response-mapper';
import { generateTraceId } from '../../../../platform/observability/domain/services/trace-id.generator';

/** Casdoor 账号状态（与 CasdoorOidcClient.fetchAccountState 返回值一致）。 */
type AccountState = 'ACTIVE' | 'DISABLED' | 'DELETED' | 'UNKNOWN';

/** GET /api/auth/session 响应 data（接口清单 §4 / API-AUTH-001 权威契约） */
export type SessionResponse = SessionResponseContract;

@Controller('api/auth')
export class CasdoorSessionController {
  private oidcClient?: CasdoorOidcClient;
  private sessionSecret?: Uint8Array;

  constructor(
    @Inject(RANA_MINDER_CONFIG) private readonly config: RanaMinderConfig,
    @Inject(CASDOOR_AVAILABILITY) private readonly availability: CasdoorAvailability,
    @Inject(IdentityUnitOfWork) private readonly uow: IdentityUnitOfWork,
    @Inject(SESSION_REVOCATION_PORT) private readonly revocationPort?: SessionRevocationPort,
    /**
     * BUG-008：nonce 存储可注入（多实例部署时替换为 Redis 等共享存储）。
     * 未注入时回退到进程内实现（单实例基线）。
     */
    @Optional()
    @Inject(OIDC_NONCE_STORE)
    private readonly nonceStoreOverride?: import('./oidc-nonce-store').OidcNonceStore,
    /** 会话身份建档/读取（可选注入：缺省时以 claims 组装契约形态，不落库） */
    @Optional()
    @Inject(SESSION_IDENTITY_REPOSITORY)
    private readonly sessionIdentity?: {
      ensureAndRead(input: {
        subjectId: string;
        casdoorOrg: string;
        casdoorName: string;
        /** 学号（控制器统一计算：claims 学号优先，兜底 org:name 限定形态） */
        studentId: string;
        displayName: string;
        email: string | null;
        emailVerifiedFromClaim: boolean;
      }): Promise<SessionIdentitySnapshot>;
    },
    /** 会话刷新委托（account-access 领域；无 code/state 的 GET session 走此路径） */
    @Optional()
    @Inject(ACCOUNT_ACCESS_CONTROLLER)
    private readonly accountAccess?: AccountAccessController,
    /**
     * 会话授权视图查询（A4 接线）。建立路径直接用其构造 workspace/permissions；
     * 刷新路径同样由 SessionAuthorizationQuery.describe 产出视图后映射契约。
     * 未装配时退化为 fail-closed：permissions=[]/workspace=null。
     */
    @Optional()
    @Inject(SESSION_AUTHZ_QUERY)
    private readonly sessionAuthz?: import('../../application/queries/session-authz.query').SessionAuthorizationQuery,
    /**
     * 匿名端点限流器（每控制器实例一个 = 每应用进程一个；注入位供测试
     * 使用独立窗口）。多实例部署边界见 AuthRateLimiter 实现注释。
     */
    @Optional()
    rateLimiterOverride?: AuthRateLimiter,
  ) {
    this.rateLimiter = rateLimiterOverride ?? new AuthRateLimiter();
  }

  private readonly rateLimiter: AuthRateLimiter;

  /** nonceStore：优先使用注入的共享存储，否则回退内存桩（单实例基线） */
  private get nonceStore(): import('./oidc-nonce-store').OidcNonceStore {
    return this.nonceStoreOverride ?? this.defaultNonceStore;
  }
  private defaultNonceStore = new InMemoryOidcNonceStore();

  /** GET /api/auth/casdoor/login-url（契约：data.loginUrl，接口清单 §4） */
  @Get('casdoor/login-url')
  async getLoginUrl(@Req() req: ExpressRequest): Promise<{ code: 0; data: { loginUrl: string } }> {
    // 匿名端点限流：超限返回 429 + Retry-After（安全分类码，不回显内部细节）
    const limit = this.rateLimiter.check(this.clientKey(req));
    if (!limit.ok) {
      throw new SessionError('请求过于频繁，请稍后再试', 429, 'CAS-ERR-RATE_LIMITED');
    }
    const client = this.ensureClient();
    const nonce = randomUUID();
    // PKCE：verifier 仅服务端持有，与 nonce 绑定入存储（一次性取出）；
    // pkce 关闭（能力验证证据支持）时该值为空串，授权 URL 不携带 challenge。
    const codeVerifier = this.config.casdoor.pkceEnabled === false ? '' : generateCodeVerifier();
    // 服务端记录本次授权请求的 nonce，回调时校验并一次性消费（登录 CSRF/会话固定防护）。
    // 共享存储（Postgres）实现为异步：必须 await 落库后再下发授权 URL，
    // 防止回调先于落库到达造成合法登录被拒。
    await this.nonceStore.issue(nonce, undefined, codeVerifier);
    try {
      const url = await client.buildAuthorizationUrl(
        codeVerifier ? { nonce, codeVerifier } : { nonce },
      );
      this.availability.markAvailable();
      return { code: 0, data: { loginUrl: url } };
    } catch (error) {
      this.availability.markUnavailable();
      throw error;
    }
  }

  /** GET /api/auth/session?code=xxx&state=yyy（契约响应信封：{code:0,data}） */
  @Get('session')
  async establishSession(
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ code: 0; data: SessionResponse }> {
    const code = req.query['code'] as string | undefined;
    const stateRaw = req.query['state'] as string | undefined;
    try {
      return await this.handleSessionRequest(req, res, code, stateRaw);
    } catch (err) {
      // 意外错误（非 HttpException）直落堆栈：observability 记录器不保留原始堆栈，
      // 联调排障需要真实 error 对象（后续由统一异常过滤器收口）。
      if (!(err instanceof HttpException)) {
        console.error('[casdoor-session] unexpected error:', err);
      }
      throw err;
    }
  }

  private async handleSessionRequest(
    req: ExpressRequest,
    res: Response,
    code: string | undefined,
    stateRaw: string | undefined,
  ): Promise<{ code: 0; data: SessionResponse }> {
    // 路由统一（联调 2026-08-27）：本路径唯一注册者。无 code/state 即「会话刷新」
    // 语义——校验会话 cookie 后委托 account-access 领域返回契约视图；
    // 无有效会话 → 401 IFC-ERR-001（与 AuthGuard 同构）。
    if (!code || !stateRaw) {
      const sub = await this.extractVerifiedSubject(req);
      if (!sub || !this.accountAccess) {
        throw new SessionError('未认证或认证失效', 401, 'IFC-ERR-001');
      }
      const refreshed = await this.accountAccess.getSession({
        subjectId: sub,
        now: new Date(),
        traceId: generateTraceId(),
      });
      if (!refreshed.ok) {
        throw new HttpException(refreshed.body, refreshed.status);
      }
      const refreshAuthz = this.sessionAuthz ? await this.sessionAuthz.describe(sub) : undefined;
      return {
        code: 0,
        data: sessionContractFromViews(sub, refreshed.value, refreshAuthz),
      };
    }

    const client = this.ensureClient();
    // 记录本次登录尝试开始前的 Casdoor 连通状态：若此前探测已判定不可用，则本次
    // 成功建立的会话仍标记为 degraded，受 CAS-FAIL-001 的 15 分钟降级窗口约束。
    const wasAvailable = this.availability.available;

    // 匿名回调端点限流（建立路径同样覆盖，防 code/nonce 盲猜与回调 DoS）
    const limit = this.rateLimiter.check(this.clientKey(req));
    if (!limit.ok) {
      throw new SessionError('请求过于频繁，请稍后再试', 429, 'CAS-ERR-RATE_LIMITED');
    }

    // 解码 state → nonce，并校验该 nonce 确由本服务签发（一次性消费）。
    // 未签发/已消费/过期一律拒绝，防登录 CSRF 与会话固定。
    // 消费同时取回服务端私有载荷（PKCE code_verifier；未启用时为空串）。
    let nonce: string;
    try {
      const state = JSON.parse(Buffer.from(stateRaw, 'base64url').toString('utf8'));
      nonce = state.nonce;
    } catch {
      throw new SessionError('Invalid state', 400);
    }
    if (typeof nonce !== 'string') {
      throw new SessionError('Invalid state', 400);
    }
    const consumedPayload = await this.nonceStore.consume(nonce);
    if (consumedPayload === null) {
      throw new SessionError('Invalid or expired state (nonce not issued by this service)', 400);
    }

    // 交换授权码 → TokenSet（Casdoor 连通失败时标记降级窗口，CAS-FAIL-001）。
    // PKCE 启用时携带与授权请求配对的 code_verifier（仅服务端持有）。
    let tokens: TokenSet;
    try {
      tokens = await client.exchangeCode(code, consumedPayload || undefined);
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

    // Set-Cookie：HttpOnly + SameSite=Lax 强制；Secure 由 cookieSecureEnforced
    // 配置强制（生产基线）或 HTTPS 探测启用（防明文截获）；Max-Age 与会话 JWT
    // 有效期对齐（默认 24h），避免"浏览器关闭即丢 Cookie 但 JWT 仍有效"的漂移。
    const secure = this.config.casdoor.cookieSecureEnforced === true || secureFromRequest(req);
    const secureAttr = secure ? '; Secure' : '';
    const maxAgeSec = this.config.casdoor.sessionCookieMaxAgeSec ?? 24 * 60 * 60;
    res.setHeader(
      'Set-Cookie',
      `session_token=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secureAttr}`,
    );

    // profileGate 联动真实账号/声明（CAS-REC-002）：emailVerified 来自 id_token 声明，
    // profileComplete 依据核心资料字段是否齐备（name 与 email 均存在）。
    const email = typeof claims['email'] === 'string' ? claims['email'] : undefined;
    const name = (claims['name'] as string) ?? sub;
    const emailVerified = claims['email_verified'] === true;
    const profileComplete = Boolean(name && email);

    // 会话身份建档（API-AUTH-001 胖 session）：库内档案优先；仓储未装配时
    // 以 claims 组装同形态响应（不落库）。
    // Casdoor 登录名：优先 name 声明（Casdoor 登录名即 name claim），
    // 兜底 preferred_username → sub（联调 2026-08-27 修正：原取 sub 导致
    // users.casdoor_name 与 Casdoor 真实登录名错位，写回读改写打不中用户）
    const casdoorName =
      (typeof claims['name'] === 'string' && claims['name']) ||
      (typeof claims['preferred_username'] === 'string' && claims['preferred_username']) ||
      sub;
    // 学号来源（B1 修复，2026-08-28）：claims 学号字段优先（真实字段形态以
    // CAS-CAP-004 能力验证证据为准）；无学号来源时以 "org:name" 限定形态兜底
    // ——Casdoor 组织内用户名唯一，org 限定消除跨组织同名对
    // uq_users_student_id 全局唯一约束的碰撞（原实现直接以用户名占位，
    // 两个组织同名用户第二个登录即 500）。
    const studentId =
      (typeof claims['studentId'] === 'string' && claims['studentId']) ||
      (typeof claims['student_id'] === 'string' && claims['student_id']) ||
      `${this.config.casdoor.organization}:${casdoorName}`;
    let snapshot: SessionIdentitySnapshot;
    try {
      if (this.sessionIdentity) {
        snapshot = await this.sessionIdentity.ensureAndRead({
          subjectId: sub,
          casdoorOrg: this.config.casdoor.organization,
          casdoorName,
          studentId,
          displayName: name,
          email: email ?? null,
          emailVerifiedFromClaim: emailVerified,
        });
      } else {
        snapshot = {
          subjectId: sub,
          studentId,
          name,
          email: email ?? null,
          phone: '',
          avatar: null,
          emailVerified,
          profileComplete,
        };
      }
    } catch (error) {
      // 学号唯一约束冲突 → 显式业务错误（非 500）：提示走姓名/学号更正流程
      if (isUniqueViolation(error)) {
        throw new SessionError(
          '学号已被其他账号占用，请联系管理员处理',
          409,
          'IFC-ERR-STUDENT-ID-CONFLICT',
        );
      }
      throw error;
    }

    const establishAuthz = this.sessionAuthz
      ? await this.sessionAuthz.describe(snapshot.subjectId)
      : undefined;
    return {
      code: 0,
      data: {
        user: {
          id: snapshot.subjectId,
          studentId: snapshot.studentId,
          name: snapshot.name,
          email: snapshot.email,
          phone: snapshot.phone,
          avatar: snapshot.avatar,
          emailVerified: snapshot.emailVerified,
          profileComplete: snapshot.profileComplete,
        },
        profileGate: {
          complete: snapshot.profileComplete,
          emailVerified: snapshot.emailVerified,
        },
        degraded,
        degradedSince: degraded ? new Date(now * 1000).toISOString() : null,
        permissions: establishAuthz ? [...establishAuthz.permissions] : [],
        workspace: establishAuthz?.workspace
          ? { ...establishAuthz.workspace, permissions: [...establishAuthz.workspace.permissions] }
          : null,
      },
    };
  }

  /** DELETE /api/auth/logout */
  @Delete('logout')
  @HttpCode(200)
  async logout(
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ code: 0; data: { endSessionUrl: string | null } }> {
    // BUG-007：登出时主动吊销该主体全部会话（不只清 Cookie）。
    // 必须验签通过后才取 sub（防未鉴权伪造任意主体吊销），并在身份域工作单元
    // 事务内写入吊销记录（SEC-CTL-004：禁止脱离事务读写）。
    if (this.revocationPort) {
      const sub = await this.extractVerifiedSubject(req);
      if (sub) {
        try {
          await this.uow.run({ kind: 'single', subjectId: sub }, async () => {
            await this.revocationPort!.invalidateAllSessions(sub);
          });
        } catch {
          // 吊销失败不阻断 Cookie 清除（客户端已不可信）
        }
      }
    }
    // 清 cookie 时使用与写入一致的 Path/HttpOnly/SameSite/Secure 属性，确保真正清除。
    const secure = this.config.casdoor.cookieSecureEnforced === true || secureFromRequest(req);
    const secureAttr = secure ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttr}`,
    );
    // RP-initiated logout（可选增强）：本地吊销完成后提供 Casdoor end_session
    // 地址供前端跳转；未配置/失败时返回 null（本地登出已闭环，不阻断）。
    let endSessionUrl: string | null = null;
    if (this.oidcClient) {
      try {
        endSessionUrl = await this.oidcClient.buildLogoutUrl();
      } catch {
        this.availability.markUnavailable();
        endSessionUrl = null;
      }
    }
    // 契约响应信封（接口清单 §1.2）：data.endSessionUrl 供前端 RP-initiated 登出
    return { code: 0, data: { endSessionUrl } };
  }

  /**
   * 提取并验签当前请求携带的会话 JWT，返回其 sub（用于登出吊销）。
   * 验签失败 / 无有效令牌返回 null（不吊销任何主体）。
   */
  private async extractVerifiedSubject(req: ExpressRequest): Promise<string | null> {
    const secret = this.sessionSecretBytes();
    if (!secret) return null;
    const token = this.extractToken(req);
    if (token === null) return null;
    try {
      const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
      return typeof payload['sub'] === 'string' ? payload['sub'] : null;
    } catch {
      return null;
    }
  }

  /** 从请求头提取会话 JWT（Bearer 或 session cookie）。 */
  private extractToken(req: ExpressRequest): string | null {
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      return auth.slice(7);
    }
    const cookie = req.headers['cookie'];
    if (typeof cookie === 'string') {
      const match = cookie.match(/(?:^|;\s*)session_token=([^;]+)/);
      if (match) return match[1];
    }
    return null;
  }

  /** 解析会话签名密钥（与签发方 deriveSessionSecret 保持一致）。 */
  private sessionSecretBytes(): Uint8Array | null {
    if (this.sessionSecret) return this.sessionSecret;
    const c = this.config.casdoor;
    if (!c?.clientSecretRef) return null;
    try {
      this.sessionSecret = deriveSessionSecret(
        this.resolveClientSecret(c.clientSecretRef),
        this.dedicatedSessionSecretOrThrow(),
      );
      return this.sessionSecret;
    } catch {
      return null;
    }
  }

  // ----- 内部 -----

  /**
   * 限流桶键：请求来源地址。不信任 x-forwarded-for（可伪造轮换绕过限流），
   * 以 socket 地址为准；反代/代理链路下所有请求聚合到代理地址，限流偏保守
   * （宁紧勿松，安全基线不受部署配置漂移影响）。
   */
  private clientKey(req: ExpressRequest): string {
    return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }

  /**
   * 专用会话密钥强制（BUG-017 演进）：生产（NODE_ENV=production）或配置
   * requireDedicatedSessionSecret=true 时，必须配置 ≥32 字符的独立会话密钥，
   * 否则 fail-closed 抛 503——禁止在生产静默回退"从 clientSecret 派生"
   * （轮换 clientSecret 会连带打掉全部在线会话，且两密钥耦合扩大攻击面）。
   */
  private dedicatedSessionSecretOrThrow(): string | undefined {
    const dedicated = this.resolveDedicatedSessionSecret();
    const enforcementOn =
      this.config.casdoor.requireDedicatedSessionSecret === true ||
      process.env.NODE_ENV === 'production';
    if (enforcementOn && (!dedicated || dedicated.length < 32)) {
      throw new SessionError(
        '会话签名密钥未配置或强度不足（需 casdoor.sessionSecretRef，≥32 字符）',
        503,
        'CAS-ERR-SESSION_SECRET_REQUIRED',
      );
    }
    return dedicated;
  }

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
      pkceEnabled: c.pkceEnabled,
      discoveryTtlMs: c.discoveryTtlMs,
    };
    this.oidcClient = new CasdoorOidcClient(oidcConfig);
    this.sessionSecret = deriveSessionSecret(clientSecret, this.dedicatedSessionSecretOrThrow());
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

  /** BUG-017：解析专用会话密钥（casdoor.sessionSecretRef）；未配置返回 undefined 回退 v1。 */
  private resolveDedicatedSessionSecret(): string | undefined {
    const ref = this.config.casdoor?.sessionSecretRef;
    if (!ref) return undefined;
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

/**
 * 判断错误是否为 PostgreSQL 唯一约束冲突（SQLSTATE 23505，或驱动以消息形态
 * 冒泡时的文本特征）。用于把学号唯一约束冲突映射为显式业务错误而非 500。
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if ((error as { code?: unknown }).code === '23505') return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('duplicate key value violates unique constraint');
}
