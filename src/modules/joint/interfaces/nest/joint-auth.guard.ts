/**
 * 联合认证守卫（interfaces/nest；未认证 401）。
 *
 * 每次受保护请求解析会话并挂载 request.jointAuthSession；未认证 → 401。
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
import { JOINT_AUTH_SESSION_PROVIDER } from '../../tokens';
import type { JointAuthSession, JointAuthSessionProvider } from './joint-auth-session';

export const JOINT_AUTH_SESSION_KEY = 'jointAuthSession';

@Injectable()
export class JointAuthGuard implements CanActivate {
  constructor(
    @Inject(JOINT_AUTH_SESSION_PROVIDER)
    private readonly sessions: JointAuthSessionProvider,
    @Inject(TRACE_CONTEXT)
    private readonly trace: TraceContextAdapter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    const session = await this.sessions.resolveSession(request as never);
    if (session === null) {
      throw new HttpException(
        {
          code: 'JNT-ERR-001',
          message: '未认证或认证失效',
          supportId: this.trace.current()?.traceId ?? generateTraceId(),
        },
        HttpStatus.UNAUTHORIZED,
      );
    }
    request[JOINT_AUTH_SESSION_KEY] = session;
    return true;
  }
}

export function jointSessionFromRequest(request: Record<string, unknown>): JointAuthSession {
  return request[JOINT_AUTH_SESSION_KEY] as JointAuthSession;
}
