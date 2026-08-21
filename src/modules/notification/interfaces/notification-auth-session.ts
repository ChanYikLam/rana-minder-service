/**
 * 通知认证会话解析（interfaces/nest；API-AUTH-001/002）。
 *
 * NotificationAuthSessionProvider 把 HTTP 请求解析为可信会话（userId + 服务端
 * 当前时间）；userId 只来自服务端认证结果，不采纳请求方自报身份（AUT 分面）。
 * 控制器一律从会话取本人标识，忽略客户端传入的 userId/operatorId（修复 IDOR）。
 *
 * 当前阶段：Casdoor OIDC 会话链路未接入，默认 RejectAll 失败关闭
 * （未认证一律返回 null → 守卫 401 IFC-ERR-001）；真实实现接入后替换
 * NOTIFICATION_AUTH_SESSION_PROVIDER 绑定（开发阶段可临时绑定
 * HeaderNotificationAuthSessionProvider，仅限可信边界内使用）。
 */

import type { Request } from 'express';

export interface NotificationAuthSession {
  /** 已认证用户主体标识（服务端认证结果，非客户端自报） */
  readonly userId: string;
  /** 已认证用户展示名称（服务端认证结果） */
  readonly displayName: string;
  readonly now: Date;
}

export interface NotificationAuthSessionProvider {
  resolveSession(request: Request): Promise<NotificationAuthSession | null>;
}

/** 认证基建接入前一律拒绝（fail-closed） */
export class RejectAllNotificationAuthSessionProvider implements NotificationAuthSessionProvider {
  async resolveSession(_request: Request): Promise<NotificationAuthSession | null> {
    return null;
  }
}

/**
 * 开发阶段会话提供器：从可信网关/认证边界注入的请求头解析身份。
 * 仅限开发与测试使用；生产必须替换为服务端认证结果（Casdoor OIDC 会话），
 * 不得在无认证边界时对外暴露。
 */
export class HeaderNotificationAuthSessionProvider implements NotificationAuthSessionProvider {
  async resolveSession(request: Request): Promise<NotificationAuthSession | null> {
    const userId = request.headers['x-user-id'];
    const displayName = request.headers['x-user-name'];
    if (typeof userId !== 'string' || userId.length === 0) return null;
    return {
      userId,
      displayName: typeof displayName === 'string' ? displayName : userId,
      now: new Date(),
    };
  }
}
