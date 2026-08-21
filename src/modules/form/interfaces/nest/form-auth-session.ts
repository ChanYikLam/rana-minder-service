/**
 * 表单认证会话解析（interfaces/nest；API-AUTH-001/002）。
 *
 * FormAuthSessionProvider 把 HTTP 请求解析为可信会话（subjectId + 服务端当前
 * 时间）；subjectId 只来自服务端认证结果，不采纳请求方自报身份（AUT 分面）。
 *
 * 当前阶段：Casdoor OIDC 会话链路未接入，默认 RejectAll 失败关闭（未认证一律
 * 返回 null → 守卫 401 IFC-ERR-001）；真实实现接入后替换
 * FORM_AUTH_SESSION_PROVIDER 绑定。
 */

import type { Request } from 'express';

export interface FormAuthSession {
  readonly subjectId: string;
  readonly now: Date;
}

export interface FormAuthSessionProvider {
  resolveSession(request: Request): Promise<FormAuthSession | null>;
}

/** 认证基建接入前一律拒绝（fail-closed） */
export class RejectAllFormAuthSessionProvider implements FormAuthSessionProvider {
  async resolveSession(_request: Request): Promise<FormAuthSession | null> {
    return null;
  }
}
