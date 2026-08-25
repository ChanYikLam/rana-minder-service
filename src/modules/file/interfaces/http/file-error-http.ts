/**
 * file 域接口错误 → HTTP 映射（API-GEN-005 脱敏输出）。
 *
 * 规则：
 * - file 域应用/领域错误多数在 message 首部携带 IFC-ERR-xxx 前缀，直接作为响应 code，
 *   HTTP 状态按全表 IFC_ERROR_HTTP_STATUS 映射；
 * - 个别无 IFC 前缀的已知异常（如短时令牌消费失败）按表映射；
 * - 未知错误 → 500 IFC-ERR-016 兜底（安全提交失败），不泄露内部细节；
 * - 错误响应只允许 code/message/supportId，符合 api-error 契约。
 */

import { IFC_ERROR_HTTP_STATUS } from '../../../../common/contracts/api-error';
import type { ApiErrorBody, ApiErrorCode } from '../../../../common/contracts/api-error';
import { generateTraceId } from '../../../../platform/observability/domain/services/trace-id.generator';

import { FileAccessDeniedError } from '../../domain/services/access-policy';
import { ShortLivedAccessRejectedError } from '../../application/queries/file-access.query';
import { InitiateUploadError } from '../../application/commands/initiate-upload.command';
import { CompleteUploadError } from '../../application/commands/complete-upload.command';
import { FileStatusQueryError } from '../../application/queries/file-status.query';
import { IllegalFileTransitionError } from '../../domain/state-machines/file-state-machine';
import { UploadLimitExceededError } from '../../domain/services/upload-policy';
import { ForbiddenFileTypeError } from '../../domain/services/file-type-guard';
import { PromoteFileError } from '../../application/commands/promote-file.command';

export interface ApiErrorResult {
  readonly ok: false;
  readonly status: number;
  readonly body: ApiErrorBody;
}

/** 无 IFC 前缀的已知异常 → 显式映射（兜底避免落入 500） */
const FILE_KNOWN_ERRORS: ReadonlyArray<{
  readonly ctor: new (...args: never[]) => Error;
  readonly code: ApiErrorCode;
  readonly status: number;
}> = [
  {
    ctor: ShortLivedAccessRejectedError,
    code: 'IFC-ERR-006',
    status: 404,
  },
];

/** 从 message 首部抽取 IFC-ERR-xxx（file 域多数错误以此前缀标记） */
function extractIfcCode(error: unknown): ApiErrorCode | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const matched = /^IFC-ERR-(\d{3}):/.exec(error.message);
  if (matched === null) {
    return null;
  }
  const candidate = `IFC-ERR-${matched[1]}` as ApiErrorCode;
  if (candidate in IFC_ERROR_HTTP_STATUS) {
    return candidate;
  }
  return null;
}

export function toApiError(error: unknown): ApiErrorResult {
  const supportId = generateTraceId();

  // 已知无 IFC 前缀异常（优先按类识别）
  for (const known of FILE_KNOWN_ERRORS) {
    if (error instanceof known.ctor) {
      return {
        ok: false,
        status: known.status,
        body: { code: known.code, message: errorMessage(error), supportId },
      };
    }
  }

  // 携带 IFC-ERR-xxx 前缀的消息（InitiateUploadError / CompleteUploadError /
  // FileStatusQueryError / IllegalFileTransitionError / UploadLimitExceededError /
  // ForbiddenFileTypeError / PromoteFileError / FileAccessDeniedError 等）
  const code = extractIfcCode(error);
  if (code !== null) {
    return {
      ok: false,
      status: IFC_ERROR_HTTP_STATUS[code],
      body: { code, message: errorMessage(error), supportId },
    };
  }

  // 未知错误兜底：500 IFC-ERR-016（安全提交失败，不泄露内部细节）
  return {
    ok: false,
    status: 500,
    body: { code: 'IFC-ERR-016', message: '安全提交失败，请稍后重试', supportId },
  };
}

/** 脱敏后的可读原因：剥离首部 IFC-ERR-xxx 前缀，仅保留安全原因文本 */
function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return '服务异常，请稍后重试';
  }
  return error.message.replace(/^IFC-ERR-\d{3}:\s*/, '');
}
