/**
 * 招新认证守卫（interfaces/nest；未认证 401）。
 *
 * 每次受保护请求解析会话并挂载 request.recruitmentAuthSession；未认证 → 401。
 * supportId 复用当前追踪上下文 traceId，与响应头 X-Trace-Id 一致。
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
import { RECRUITMENT_AUTH_SESSION_PROVIDER } from '../../tokens';
import type {
  RecruitmentAuthSession,
  RecruitmentAuthSessionProvider,
} from './recruitment-auth-session';

export const RECRUITMENT_AUTH_SESSION_KEY = 'recruitmentAuthSession';

@Injectable()
export class RecruitmentAuthGuard implements CanActivate {
  constructor(
    @Inject(RECRUITMENT_AUTH_SESSION_PROVIDER)
    private readonly sessions: RecruitmentAuthSessionProvider,
    @Inject(TRACE_CONTEXT)
    private readonly trace: TraceContextAdapter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    const session = await this.sessions.resolveSession(request as never);
    if (session === null) {
      throw new HttpException(
        {
          code: 'REC-ERR-001',
          message: '未认证或认证失效',
          supportId: this.trace.current()?.traceId ?? generateTraceId(),
        },
        HttpStatus.UNAUTHORIZED,
      );
    }
    request[RECRUITMENT_AUTH_SESSION_KEY] = session;
    return true;
  }
}

export function recruitmentSessionFromRequest(
  request: Record<string, unknown>,
): RecruitmentAuthSession {
  return request[RECRUITMENT_AUTH_SESSION_KEY] as RecruitmentAuthSession;
}
