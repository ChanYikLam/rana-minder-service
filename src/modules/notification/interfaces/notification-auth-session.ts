/**
 * 通知认证会话解析（interfaces/nest；API-AUTH-001/002）。
 *
 * NotificationAuthSessionProvider 把 HTTP 请求解析为可信会话（userId + 服务端
 * 当前时间）；userId 只来自服务端认证结果，不采纳请求方自报身份（AUT 分面）。
 * 控制器一律从会话取本人标识，忽略客户端传入的 userId/operatorId（修复 IDOR）。
 *
 * 当前阶段：Casdoor OIDC 会话链路未接入，默认 RejectAll 失败关闭
 * （未认证一律返回 null → 守卫 401 IFC-ERR-001）；真实实现接入后替换
 * NOTIFICATION_AUTH_SESSION_PROVIDER 绑定。
 * 注意：不提供任何"信任客户端请求头"的会话实现（那会重新引入 IDOR），
 * 开发/测试需要会话时在测试代码中自建桩。
 */

import type { Request } from 'express';

export interface NotificationAuthSession {
  /** 已认证用户主体标识（服务端认证结果，非客户端自报） */
  readonly userId: string;
  /** 已认证用户展示名称（服务端认证结果） */
  readonly displayName: string;
  readonly now: Date;
  /**
   * 服务端解析的权限码集合（如 club:email:config、club:config:manage）。
   * 只来自服务端会话/角色解析，不采纳客户端自报；未提供视为空集
   * （fail-closed：邮件配置等特权端点将被拒绝，NTF-006）。
   */
  readonly permissions?: readonly string[];
  /** 平台超管标记（服务端解析；未提供视为 false） */
  readonly isPlatformAdmin?: boolean;
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
