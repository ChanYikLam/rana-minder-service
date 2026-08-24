/**
 * 邀请认证守卫（interfaces/nest；未认证 401，与 recruitment-auth.guard 同构）。
 */

import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';

import { TRACE_CONTEXT } from '../../../../platform/observability/tracing/tokens';
import type { TraceContextAdapter } from '../../../../platform/observability/infrastructure/trace-context.adapter';
import { generateTraceId } from '../../../../platform/observability/domain/services/trace-id.generator';
import { INVITATION_AUTH_SESSION_PROVIDER } from './invitation-auth-session';
import type {
  InvitationAuthSession,
  InvitationAuthSessionProvider,
} from './invitation-auth-session';

export const INVITATION_AUTH_SESSION_KEY = 'invitationAuthSession';

@Injectable()
export class InvitationAuthGuard implements CanActivate {
  constructor(
    @Inject(INVITATION_AUTH_SESSION_PROVIDER)
    private readonly sessions: InvitationAuthSessionProvider,
    @Inject(TRACE_CONTEXT)
    private readonly trace: TraceContextAdapter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    const session = await this.sessions.resolveSession(request as never);
    if (session === null) {
      throw new HttpException(
        {
          code: 'IFC-ERR-001',
          message: '未认证或认证失效',
          supportId: this.trace.current()?.traceId ?? generateTraceId(),
        },
        HttpStatus.UNAUTHORIZED,
      );
    }
    request[INVITATION_AUTH_SESSION_KEY] = session;
    return true;
  }
}

export function invitationSessionFromRequest(
  request: Record<string, unknown>,
): InvitationAuthSession | undefined {
  return request[INVITATION_AUTH_SESSION_KEY] as InvitationAuthSession | undefined;
}
