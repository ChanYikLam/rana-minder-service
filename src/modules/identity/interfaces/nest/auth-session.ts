/**
 * 认证会话解析（interfaces/nest；API-AUTH-001/002）。
 *
 * AuthSessionProvider 把 HTTP 请求解析为可信会话（subjectId + 服务端当前时间）；
 * subjectId 只来自服务端认证结果，不采纳请求方自报身份（AUT 分面）。
 *
 * 当前阶段：Casdoor OIDC 会话链路未接入，默认 RejectAll 失败关闭
 * （未认证一律返回 null → 守卫 401 IFC-ERR-001）；真实实现接入后替换
 * AUTH_SESSION_PROVIDER 绑定（如从会话存储解析 Bearer token）。
 */

import type { Request } from 'express';

export interface AuthSession {
  readonly subjectId: string;
  readonly now: Date;
  /** 平台发信能力（由会话/网关绑定注入；缺失按不可用处理，安全侧保守） */
  readonly mailCapable?: boolean;
}

export interface AuthSessionProvider {
  /** 解析可信会话；无法认证时返回 null（不抛出、不猜测主体） */
  resolveSession(request: Request): Promise<AuthSession | null>;
}

/** 认证基建接入前一律拒绝（fail-closed） */
export class RejectAllAuthSessionProvider implements AuthSessionProvider {
  async resolveSession(_request: Request): Promise<AuthSession | null> {
    return null;
  }
}