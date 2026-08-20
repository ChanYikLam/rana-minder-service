/**
 * 接口层错误 → HTTP 映射（API-ERR-001 全表 + API-GEN-005 脱敏输出）。
 *
 * 规则：
 * - 错误码直接采用 IFC-ERR-xxx 作为响应 code；HTTP 状态按 §7 全表映射；
 * - 错误响应只允许 code/message/supportId/fieldErrors；
 * - 未知错误 → 500 IFC-ERR-016 兜底（安全提交失败），不泄露内部细节；
 * - 个别端点例外：verify-email 验证码错误/过期 → IFC-ERR-007 以 422 返回并携带
 *   fieldErrors（接口清单 §4 备注；接口实现规格 §7 注）。
 */

import {
  IdentityCommandError,
  IdentityErrorCode,
  type IdentityErrorCode as IdentityErrorCodeType,
} from '../../application/errors';
import { IFC_ERROR_HTTP_STATUS } from '../../../../common/contracts/api-error';
import type { ApiErrorBody, ApiFieldErrors } from '../../../../common/contracts/api-error';
import { generateTraceId } from '../../../../platform/observability/domain/services/trace-id.generator';

export interface ApiErrorResult {
  readonly ok: false;
  readonly status: number;
  readonly body: ApiErrorBody;
}

export function toApiError(error: unknown): ApiErrorResult {
  const supportId = generateTraceId();
  if (error instanceof IdentityCommandError) {
    return {
      ok: false,
      status: IFC_ERROR_HTTP_STATUS[error.code as IdentityErrorCodeType],
      body: {
        code: error.code,
        message: error.message,
        supportId,
        ...(isRecord(error.details) && isRecord(error.details.fieldErrors)
          ? { fieldErrors: error.details.fieldErrors as ApiFieldErrors }
          : {}),
      },
    };
  }
  return {
    ok: false,
    status: 500,
    body: {
      code: IdentityErrorCode.SECURITY_COMMIT_FAILED,
      message: '安全提交失败，请稍后重试',
      supportId,
    },
  };
}

/**
 * verify-email 例外映射（接口清单 §4）：验证码错误/过期/已使用 → IFC-ERR-007，
 * HTTP 422 + fieldErrors.code。
 */
export function toVerifyEmailError(error: unknown): ApiErrorResult {
  if (
    error instanceof IdentityCommandError &&
    error.code === IdentityErrorCode.PRECONDITION_FAILED
  ) {
    return {
      ok: false,
      status: 422,
      body: {
        code: IdentityErrorCode.STATE_CONFLICT,
        message: error.message,
        supportId: generateTraceId(),
        fieldErrors: { code: [error.message] },
      },
    };
  }
  return toApiError(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
