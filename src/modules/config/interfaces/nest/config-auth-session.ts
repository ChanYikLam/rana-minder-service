/**
 * config 认证会话解析（interfaces/nest；API-AUTH-001/002）。
 *
 * ConfigAuthSessionProvider 把 HTTP 请求解析为可信会话（subjectId + 服务端当前
 * 时间）；subjectId 只来自服务端认证结果，不采纳请求方自报身份（AUT 分面）。
 *
 * 当前阶段：Casdoor OIDC 会话链路经 identity AUTH_SESSION_PROVIDER 适配接入；
 * 未认证一律返回 null → 守卫 401（fail-closed）。
 */

import type { Request } from 'express';

export interface ConfigAuthSession {
  readonly subjectId: string;
  readonly now: Date;
}

export interface ConfigAuthSessionProvider {
  resolveSession(request: Request): Promise<ConfigAuthSession | null>;
}

/** 认证基建接入前一律拒绝（fail-closed） */
export class RejectAllConfigAuthSessionProvider implements ConfigAuthSessionProvider {
  async resolveSession(_request: Request): Promise<ConfigAuthSession | null> {
    return null;
  }
}
