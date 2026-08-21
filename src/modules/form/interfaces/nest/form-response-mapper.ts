/**
 * 表单传输层响应映射（interfaces/nest；API-GEN-004）。
 *
 * - 成功：`{ ok: true, value }` → HTTP 200 `{ code: 0, data: value }`；
 * - 拒绝：`{ ok: false, status, body }` → HttpException 原样透传 body（错误响应
 *   只含 code/message/supportId/fieldErrors，API-GEN-005）。
 */

import { HttpException } from '@nestjs/common';

import type { ApiSuccess } from '../../../../common/contracts/api-envelope';
import type { ApiErrorResult } from '../http/form-error-http';
import type { ActorContext } from '../controllers/actor-context';
import { generateTraceId } from '../../../../platform/observability/domain/services/trace-id.generator';
import { formSessionFromRequest } from './form-auth.guard';
import type { FormAuthSession } from './form-auth-session';

export type FormNestControllerResult<T> = { readonly ok: true; readonly value: T } | ApiErrorResult;

export function toHttpResponse<T>(result: FormNestControllerResult<T>): ApiSuccess<T> {
  if (result.ok) {
    return { code: 0, data: result.value };
  }
  throw new HttpException(result.body, result.status);
}

/** 由守卫挂载的会话构造 ActorContext（subjectId 恒来自会话，AUT 分面） */
export function actorFromRequest(
  request: Record<string, unknown>,
  traceId: string | null,
): ActorContext {
  const session = formSessionFromRequest(request);
  return {
    subjectId: session.subjectId,
    now: session.now,
    traceId: traceId ?? generateTraceId(),
  };
}

export function toFormActorContext(session: FormAuthSession, traceId: string | null): ActorContext {
  return {
    subjectId: session.subjectId,
    now: session.now,
    traceId: traceId ?? generateTraceId(),
  };
}
