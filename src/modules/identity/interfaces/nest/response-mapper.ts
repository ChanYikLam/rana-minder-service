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

/** GET /api/auth/session 响应 data（接口清单 §4 / API-AUTH-001 权威契约） */
export interface SessionResponseContract {
  user: {
    id: string;
    studentId: string;
    name: string;
    email: string | null;
    phone: string;
    avatar: string | null;
    emailVerified: boolean;
    profileComplete: boolean;
  };
  profileGate: {
    complete: boolean;
    emailVerified: boolean;
  };
  degraded: boolean;
  degradedSince: string | null;
  permissions: string[];
  workspace: null;
}

/**
 * 会话刷新视图（profile + accountAccess）→ 契约会话视图。
 * 供 account-access / casdoor-session 两个会话读取路径复用，保证
 * 「建立会话」与「刷新会话」输出同构（前端单一 zod schema 可校验）。
 */
export function sessionContractFromViews(
  subjectId: string,
  view: {
    profile: {
      studentId: string | null;
      name: string | null;
      email: string | null;
      phone: string | null;
      emailVerified: boolean;
      profileComplete: boolean;
    };
    accountAccess: {
      degraded: boolean;
      degradedSince: string | null;
    };
  },
): SessionResponseContract {
  return {
    user: {
      id: subjectId,
      studentId: view.profile.studentId ?? '',
      name: view.profile.name ?? '',
      email: view.profile.email,
      phone: view.profile.phone ?? '',
      avatar: null,
      emailVerified: view.profile.emailVerified,
      profileComplete: view.profile.profileComplete,
    },
    profileGate: {
      complete: view.profile.profileComplete,
      emailVerified: view.profile.emailVerified,
    },
    degraded: view.accountAccess.degraded,
    degradedSince: view.accountAccess.degradedSince,
    permissions: [],
    workspace: null,
  };
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
