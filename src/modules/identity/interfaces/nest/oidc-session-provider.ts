/**
 * OIDC 会话解析器（interfaces/nest；API-AUTH-001、CAS-REC-002、CAS-FAIL-001）。
 *
 * 从请求头中提取 Bearer token 或 session cookie，验证本地签发的会话 JWT
 * （HS256），返回 AuthSession。每次解析实时复查账号状态（CAS-REC-002：禁用/
 * 删除即时失效）；降级会话（degraded）在 Casdoor 不可用时仅保留 15 分钟窗口
 * （CAS-FAIL-001）。
 *
 * 配置驱动：casdoor.endpoint 为空时仍使用 RejectAllAuthSessionProvider
 * （fail-closed 门控）；配置存在时由本实现替换。
 */

import type { Request } from 'express';
import { jwtVerify, SignJWT } from 'jose';
import type { AuthSession, AuthSessionProvider } from './auth-session';

export interface SessionClaims {
  readonly sub: string;
  readonly name?: string;
  readonly email?: string;
  readonly iat: number;
  readonly degraded: boolean;
}

/** 账号实时状态观测结果：ACTIVE/DISABLED/DELETED，或 null（无法确定/未接线）。 */
export type AccountStateObservation = 'ACTIVE' | 'DISABLED' | 'DELETED' | null;

export interface OidcSessionConfig {
  readonly sessionSecret: Uint8Array;
  /** 实时复查账号状态；null 表示无法确定（Casdoor 不可达或未接线）。 */
  readonly checkAccountState: (subjectId: string) => Promise<AccountStateObservation>;
  /** Casdoor 当前是否可用（运行时观测，CAS-FAIL-001 降级窗口判定依据）。 */
  readonly isCasdoorAvailable: () => boolean;
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

      // CAS-REC-002 实时读回：每次请求复查账号状态；禁用/删除即时拒绝。
      const state = await this.config.checkAccountState(sub);
      if (state === 'DISABLED' || state === 'DELETED') {
        return null;
      }

      // CAS-FAIL-001：Casdoor 不可用且会话为降级签发，超 15 分钟拒绝。
      if (degraded) {
        const ageMs = now.getTime() - iat * 1000;
        const casdoorAvailable = this.config.isCasdoorAvailable();
        if (!casdoorAvailable && ageMs > 15 * 60 * 1000) {
          return null; // 降级窗口过期
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
