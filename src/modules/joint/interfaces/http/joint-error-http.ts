/**
 * 联合域接口错误 → HTTP 映射（API-GEN-005 脱敏输出）。
 *
 * 错误码采用 JNT_* 作为响应 code；HTTP 状态按表映射；未知错误 → 500 兜底，
 * 不泄露内部细节。JointConflictError（仓储乐观锁未命中）→ 409。
 */

import { JointDomainError } from '../../domain/errors';
import { JointConflictError } from '../../application/ports/joint-repository.port';
import { generateTraceId } from '../../../../platform/observability/domain/services/trace-id.generator';

export interface ApiErrorResult {
  readonly ok: false;
  readonly status: number;
  readonly body: { code: string; message: string; supportId: string };
}

const JOINT_ERROR_HTTP_STATUS: Record<string, number> = {
  JNT_FORBIDDEN: 403,
  JNT_NOT_FOUND: 404,
  JNT_CONFLICT: 409,
  JNT_PRECONDITION: 409,
  JNT_VALIDATION: 400,
};

export function toApiError(error: unknown): ApiErrorResult {
  const supportId = generateTraceId();
  if (error instanceof JointDomainError) {
    return {
      ok: false,
      status: JOINT_ERROR_HTTP_STATUS[error.code] ?? 500,
      body: { code: error.code, message: error.message, supportId },
    };
  }
  if (error instanceof JointConflictError) {
    return {
      ok: false,
      status: 409,
      body: { code: 'JNT_CONFLICT', message: error.message, supportId },
    };
  }
  return {
    ok: false,
    status: 500,
    body: { code: 'JNT-ERR-001', message: '服务异常，请稍后重试', supportId },
  };
}
