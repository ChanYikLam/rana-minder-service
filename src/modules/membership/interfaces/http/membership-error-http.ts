/**
 * membership 域接口错误 → HTTP 映射（API-GEN-005 脱敏输出）。
 *
 * 规则：
 * - membership 应用层各命令抛出的领域错误以 `IFC-ERR-NNN` 作为 message 前缀，
 *   部分错误类另携带 `code` 属性；统一抽取错误码作为响应 code；
 * - HTTP 状态按 api-error 全表映射；未知错误 → 500 IFC-ERR-016 兜底，
 *   不泄露内部细节。
 */

import { generateTraceId } from '../../../../platform/observability/domain/services/trace-id.generator';
import { IFC_ERROR_HTTP_STATUS } from '../../../../common/contracts/api-error';
import type { ApiErrorBody, ApiErrorCode } from '../../../../common/contracts/api-error';

export interface MembershipApiErrorResult {
  readonly ok: false;
  readonly status: number;
  readonly body: ApiErrorBody;
}

/** 从错误对象抽取 IFC-ERR-NNN 错误码（优先 code 属性，回退 message 前缀） */
function extractErrorCode(error: unknown): ApiErrorCode | null {
  const candidate =
    error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (typeof candidate === 'string' && /^IFC-ERR-\d{3}$/.test(candidate)) {
    return candidate as ApiErrorCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  const matched = message.match(/^IFC-ERR-(\d{3})/);
  return matched === null ? null : (`IFC-ERR-${matched[1]}` as ApiErrorCode);
}

export function toApiError(error: unknown): MembershipApiErrorResult {
  const supportId = generateTraceId();
  const code = extractErrorCode(error);
  if (code !== null) {
    return {
      ok: false,
      status: IFC_ERROR_HTTP_STATUS[code] ?? 500,
      body: {
        code,
        message: error instanceof Error ? error.message : String(error),
        supportId,
      },
    };
  }
  return {
    ok: false,
    status: 500,
    body: {
      code: 'IFC-ERR-016',
      message: '服务异常，请稍后重试',
      supportId,
    },
  };
}
