/**
 * OIDC 会话解析器（interfaces/nest；API-AUTH-001、CAS-REC-002）。
 *
 * 从请求头中提取 Bearer token 或 session cookie，验证本地签发的会话 JWT
 * （HS256），返回 AuthSession。Casdoor 实例不可用时，若会话 JWT 签发于
 * 15 分钟内且非增强认证路径，可返回 degraded 会话（CAS-FAIL-001）。
 *
 * BUG-003 读侧接线：resolveSession 在 JWT 验签通过后比对令牌 iat 与
 * 撤销时间（revocationReader），已被吊销的会话立即返回 null（≤5s 生效）。
 *
 * 配置驱动：casdoor.endpoint 为空时仍使用 RejectAllAuthSessionProvider
 * （fail-closed 门控）；配置存在时由本实现替换。
 */

import type { Request } from 'express';
import { jwtVerify, SignJWT } from 'jose';
import type { AuthSession, AuthSessionProvider } from './auth-session';
import type { CasdoorAvailability } from './casdoor-availability';
import type { SessionRevocation } from '../../application/ports/session-revocation.port';

export interface SessionClaims {
  readonly sub: string;
  readonly name?: string;
  readonly email?: string;
  readonly iat: number;
  readonly degraded: boolean;
}

/** 会话撤销状态（由 SessionRevocationPort.getRevocation 返回） */


export interface OidcSessionConfig {
  readonly sessionSecret: Uint8Array;
  /**
   * 上一轮 Casdoor 连通探测结果。可为静态布尔值（测试/固定场景）或共享的
   * CasdoorAvailability 状态对象（运行时由会话控制器动态更新，CAS-FAIL-001）。
   */
  readonly casdoorAvailable: boolean | CasdoorAvailability;
  /**
   * BUG-003 读侧接线：会话撤销版本读取端口（可选，未注入时不校验吊销）。
   * resolveSession 在 JWT 验签通过后比对令牌 iat 与撤销时间，
   * 已被吊销的会话立即返回 null。
   */
  readonly revocationReader?: (subjectId: string) => Promise<SessionRevocation | null>;
}

export class OidcAuthSessionProvider implements AuthSessionProvider {
  constructor(private readonly config: OidcSessionConfig) {}

  async resolveSession(request: Request): Promise<AuthSession | null> {
    const token = extractBearerToken(request);
    if (token === null) return null;

    try {
      const { payload } = await jwtVerify(token, this.config.sessionSecret, {
        algorithms: ['HS256'],
      });
      const sub = typeof payload['sub'] === 'string' ? payload['sub'] : '';
      if (sub.length === 0) return null;

      const now = new Date();
      const iat = typeof payload['iat'] === 'number' ? payload['iat'] : 0;
      const degraded = payload['degraded'] === true;
      const casdoorAvailable =
        typeof this.config.casdoorAvailable === 'boolean'
          ? this.config.casdoorAvailable
          : this.config.casdoorAvailable.available;

      // CAS-FAIL-001：Casdoor 不可用且会话签发超过 15 分钟 → 拒绝
      if (degraded && !casdoorAvailable) {
        const ageMs = now.getTime() - iat * 1000;
        if (ageMs > 15 * 60 * 1000) {
          return null; // 降级窗口过期
        }
      }

      // BUG-003 读侧接线：比对撤销版本——吊销后签发的旧令牌立即失效
      if (this.config.revocationReader) {
        const revocation = await this.config.revocationReader(sub);
        if (revocation !== null && revocation.revokedAt !== null) {
          const revokedAtMs = new Date(revocation.revokedAt).getTime();
          if (iat * 1000 <= revokedAtMs) {
            return null; // 令牌签发早于或等于吊销时刻 → 已被吊销
          }
        }
      }

      return {
        subjectId: sub,
        now,
        mailCapable: typeof payload['email'] === 'string' && payload['email'].length > 0,
      };
    } catch {
      return null;
    }
  }

  /** 签发会话 JWT（24h 有效期） */
  static async signSession(claims: SessionClaims, secret: Uint8Array): Promise<string> {
    return new SignJWT({
      sub: claims.sub,
      name: claims.name ?? '',
      email: claims.email ?? '',
      iat: claims.iat,
      degraded: claims.degraded,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('24h')
      .sign(secret);
  }
}

function extractBearerToken(request: Request): string | null {
  const auth = request.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  // 回退：session cookie
  const cookie = request.headers['cookie'];
  if (typeof cookie === 'string') {
    const match = cookie.match(/(?:^|;\s*)session_token=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}
