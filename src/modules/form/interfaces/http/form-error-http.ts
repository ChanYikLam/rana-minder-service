/**
 * 表单域接口错误 → HTTP 映射（API-ERR-001 全表 + API-GEN-005 脱敏输出）。
 *
 * 规则：错误码直接采用 IFC-ERR-xxx 作为响应 code；HTTP 状态按 §7 全表映射；
 * 错误响应只允许 code/message/supportId/fieldErrors；未知错误 → 500
 * IFC-ERR-016 兜底，不泄露内部细节。
 */

import {
  FormCommandError,
  FormErrorCode,
  type FormErrorCode as FormErrorCodeType,
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
  if (error instanceof FormCommandError) {
    return {
      ok: false,
      status: IFC_ERROR_HTTP_STATUS[error.code as FormErrorCodeType],
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
      code: FormErrorCode.SECURITY_COMMIT_FAILED,
      message: '安全提交失败，请稍后重试',
      supportId,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
