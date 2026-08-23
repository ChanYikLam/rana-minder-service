/**
 * 邀请认证会话解析（interfaces/nest；API-AUTH-001）。
 *
 * 经 adaptSessionProvider 转发到 identity 的 AUTH_SESSION_PROVIDER（B3 OIDC
 * 会话链路）；identity 侧 casdoor.endpoint 为空时整体退回 RejectAll fail-closed。
 */

import type { Request } from 'express';

export const INVITATION_AUTH_SESSION_PROVIDER = Symbol('INVITATION_AUTH_SESSION_PROVIDER');

export interface InvitationAuthSession {
  readonly subjectId: string;
  readonly now: Date;
}

export interface InvitationAuthSessionProvider {
  resolveSession(request: Request): Promise<InvitationAuthSession | null>;
}
