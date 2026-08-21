/**
 * 招新域接口错误 → HTTP 映射（API-GEN-005 脱敏输出）。
 *
 * 错误码采用 REC_* 作为响应 code；HTTP 状态按表映射；未知错误 → 500 兜底，
 * 不泄露内部细节。
 */

import { RecruitmentError } from '../../application/errors';
import { generateTraceId } from '../../../../platform/observability/domain/services/trace-id.generator';

export interface ApiErrorResult {
  readonly ok: false;
  readonly status: number;
  readonly body: { code: string; message: string; supportId: string };
}

const RECRUITMENT_ERROR_HTTP_STATUS: Record<string, number> = {
  REC_FORBIDDEN: 403,
  REC_NOT_FOUND: 404,
  REC_CONFLICT: 409,
  REC_PRECONDITION: 409,
  REC_VALIDATION: 400,
};

export function toApiError(error: unknown): ApiErrorResult {
  const supportId = generateTraceId();
  if (error instanceof RecruitmentError) {
    return {
      ok: false,
      status: RECRUITMENT_ERROR_HTTP_STATUS[error.code] ?? 500,
      body: { code: error.code, message: error.message, supportId },
    };
  }
  return {
    ok: false,
    status: 500,
    body: { code: 'REC-ERR-016', message: '服务异常，请稍后重试', supportId },
  };
}
