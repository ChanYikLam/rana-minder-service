/**
 * 招新 HTTP 响应映射与执行主体解析（interfaces/nest）。
 */

import { HttpException } from '@nestjs/common';

import type { ApiSuccess } from '../../../../common/contracts/api-envelope';
import { generateTraceId } from '../../../../platform/observability/domain/services/trace-id.generator';
import type { ApiErrorResult } from '../http/recruitment-error-http';
import { RECRUITMENT_AUTH_SESSION_KEY } from './recruitment-auth.guard';
import type { RecruitmentAuthSession } from './recruitment-auth-session';
import type { ActorContext } from '../controllers/actor-context';

export function toHttpResponse(
  result: { readonly ok: true; readonly value: unknown } | ApiErrorResult,
): ApiSuccess<unknown> {
  if (result.ok) {
    return { code: 0, data: result.value };
  }
  throw new HttpException(result.body, result.status);
}

export function actorFromRequest(request: Record<string, unknown>, traceId: string | null): ActorContext {
  const session = request[RECRUITMENT_AUTH_SESSION_KEY] as RecruitmentAuthSession | undefined;
  if (session === undefined) {
    throw new HttpException(
      { code: 'REC-ERR-001', message: '未认证或认证失效', supportId: generateTraceId() },
      401,
    );
  }
  return {
    subjectId: session.subjectId,
    now: session.now,
    traceId: traceId ?? generateTraceId(),
  };
}
