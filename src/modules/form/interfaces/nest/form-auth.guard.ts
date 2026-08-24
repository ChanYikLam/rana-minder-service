/**
 * 表单认证守卫（interfaces/nest；IFC-ERR-001 未认证 401）。
 *
 * 每次受保护请求解析会话并挂载 request.formAuthSession；未认证 → 401
 * IFC-ERR-001（错误响应只含 code/message/supportId，API-GEN-005）。
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
import { FORM_AUTH_SESSION_PROVIDER } from '../../tokens';
import type { FormAuthSession, FormAuthSessionProvider } from './form-auth-session';

export const FORM_AUTH_SESSION_KEY = 'formAuthSession';

@Injectable()
export class FormAuthGuard implements CanActivate {
  constructor(
    @Inject(FORM_AUTH_SESSION_PROVIDER)
    private readonly sessions: FormAuthSessionProvider,
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
    request[FORM_AUTH_SESSION_KEY] = session;
    return true;
  }
}

export function formSessionFromRequest(request: Record<string, unknown>): FormAuthSession {
  return request[FORM_AUTH_SESSION_KEY] as FormAuthSession;
}
