/**
 * audit 域接口错误 → HTTP 映射（API-ERR-001 全表 + API-GEN-005 脱敏输出）。
 *
 * 规则：
 * - 领域错误以 `IFC-ERR-xxx: 消息` 形式抛出（CorrectionCommandError 或普通
 *   Error，如 AuditQuery / ArchiveAccessQuery / CorrectionStateMachine 的状态
 *   冲突），直接采用 IFC-ERR-xxx 作为响应 code，HTTP 状态按 §7 全表映射；
 * - 错误响应只允许 code/message/supportId；
 * - 未知错误 → 500 IFC-ERR-016 兜底（安全提交失败），不泄露内部细节。
 */

import { generateTraceId } from '../../../../platform/observability/domain/services/trace-id.generator';
import { IFC_ERROR_HTTP_STATUS } from '../../../../common/contracts/api-error';
import type { ApiErrorBody, ApiErrorCode } from '../../../../common/contracts/api-error';

export interface ApiErrorResult {
  readonly ok: false;
  readonly status: number;
  readonly body: ApiErrorBody;
}

const IFC_CODE_PREFIX = /^(IFC-ERR-\d+):\s*(.*)$/;

export function toApiError(error: unknown): ApiErrorResult {
  const supportId = generateTraceId();
  if (error instanceof Error) {
    const matched = IFC_CODE_PREFIX.exec(error.message);
    if (matched !== null) {
      const code = matched[1] as ApiErrorCode;
      const status = IFC_ERROR_HTTP_STATUS[code];
      if (status !== undefined) {
        return {
          ok: false,
          status,
          body: { code, message: matched[2] ?? error.message, supportId },
        };
      }
    }
  }
  return {
    ok: false,
    status: 500,
    body: { code: 'IFC-ERR-016', message: '安全提交失败，请稍后重试', supportId },
  };
}
