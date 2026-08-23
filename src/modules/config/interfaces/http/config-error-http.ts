/**
 * config 域接口错误 → HTTP 映射（API-GEN-005 脱敏输出）。
 *
 * 错误码采用 CFG_* 作为响应 code；HTTP 状态按表映射；未知错误 → 500 兜底，
 * 不泄露内部细节。
 */

import { ConfigDomainError } from '../../domain/errors';
import { generateTraceId } from '../../../../platform/observability/domain/services/trace-id.generator';

export interface ApiErrorResult {
  readonly ok: false;
  readonly status: number;
  readonly body: { code: string; message: string; supportId: string };
}

const CONFIG_ERROR_HTTP_STATUS: Record<string, number> = {
  CFG_VALIDATION: 400,
  CFG_FORBIDDEN: 403,
  CFG_NOT_FOUND: 404,
  CFG_CONFLICT: 409,
  CFG_PRECONDITION: 409,
  CFG_VERSION_CONFLICT: 409,
};

export function toApiError(error: unknown): ApiErrorResult {
  const supportId = generateTraceId();
  if (error instanceof ConfigDomainError) {
    return {
      ok: false,
      status: CONFIG_ERROR_HTTP_STATUS[error.code] ?? 500,
      body: { code: error.code, message: error.message, supportId },
    };
  }
  return {
    ok: false,
    status: 500,
    body: { code: 'CFG-ERR-016', message: '服务异常，请稍后重试', supportId },
  };
}
