/**
 * 传输层响应映射（interfaces/nest；API-GEN-004）。
 *
 * - 成功：`{ ok: true, value }` → HTTP 200 `{ code: 0, data: value }`；
 * - 拒绝：`{ ok: false, status, body }` → HttpException 原样透传 body（错误响应
 *   只含 code/message/supportId/fieldErrors，API-GEN-005）。
 */

import { HttpException } from '@nestjs/common';

import type { ApiSuccess } from '../../../../common/contracts/api-envelope';
import type { ApiErrorResult } from '../http/error-http';
import type { ActorContext } from '../controllers/profiles.controller';
import { generateTraceId } from '../../../../platform/observability/domain/services/trace-id.generator';
import { sessionFromRequest } from './auth.guard';
import type { AuthSession } from './auth-session';

export type NestControllerResult<T> = { readonly ok: true; readonly value: T } | ApiErrorResult;

export function toHttpResponse<T>(result: NestControllerResult<T>): ApiSuccess<T> {
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
  const session = sessionFromRequest(request);
  return toActorContext(session, traceId);
}

export function toActorContext(session: AuthSession, traceId: string | null): ActorContext {
  return {
    subjectId: session.subjectId,
    now: session.now,
    traceId: traceId ?? generateTraceId(),
    mailCapable: session.mailCapable ?? false,
  };
}