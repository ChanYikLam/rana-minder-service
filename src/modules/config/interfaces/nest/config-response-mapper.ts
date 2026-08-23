/**
 * config HTTP 响应映射与执行主体解析（interfaces/nest）。
 */

import { HttpException } from '@nestjs/common';

import type { ApiSuccess } from '../../../../common/contracts/api-envelope';
import { generateTraceId } from '../../../../platform/observability/domain/services/trace-id.generator';
import type { ApiErrorResult } from '../http/config-error-http';
import { CONFIG_AUTH_SESSION_KEY } from './config-auth.guard';
import type { ConfigAuthSession } from './config-auth-session';

export function toHttpResponse(
  result: { readonly ok: true; readonly value: unknown } | ApiErrorResult,
): ApiSuccess<unknown> {
  if (result.ok) {
    return { code: 0, data: result.value };
  }
  throw new HttpException(result.body, result.status);
}

/** 执行主体：受保护端点守卫已挂载会话；缺失即接口层缺陷，401 兜底 */
export function configActorFromRequest(request: Record<string, unknown>): ConfigAuthSession {
  const session = request[CONFIG_AUTH_SESSION_KEY] as ConfigAuthSession | undefined;
  if (session === undefined) {
    throw new HttpException(
      { code: 'CFG-ERR-001', message: '未认证或认证失效', supportId: generateTraceId() },
      401,
    );
  }
  return session;
}
