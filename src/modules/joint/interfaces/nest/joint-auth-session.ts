/**
 * 联合认证会话解析（interfaces/nest；API-AUTH-001/002）。
 *
 * JointAuthSessionProvider 把 HTTP 请求解析为可信会话（subjectId + 服务端当前
 * 时间）；subjectId 只来自服务端认证结果，不采纳请求方自报身份（AUT 分面）。
 *
 * 当前阶段：Casdoor OIDC 会话链路未接入，默认 RejectAll 失败关闭（未认证一律
 * 返回 null → 守卫 401）；真实实现接入后替换 JOINT_AUTH_SESSION_PROVIDER 绑定。
 */

import type { Request } from 'express';

import { JOINT_AUTH_SESSION_PROVIDER } from '../../tokens';

export interface JointAuthSession {
  readonly subjectId: string;
  readonly now: Date;
}

export interface JointAuthSessionProvider {
  resolveSession(request: Request): Promise<JointAuthSession | null>;
}

/** 认证基建接入前一律拒绝（fail-closed） */
export class RejectAllJointAuthSessionProvider implements JointAuthSessionProvider {
  async resolveSession(_request: Request): Promise<JointAuthSession | null> {
    return null;
  }
}

export { JOINT_AUTH_SESSION_PROVIDER };
