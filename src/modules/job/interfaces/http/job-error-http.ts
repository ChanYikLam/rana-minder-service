/**
 * job 域接口错误 → HTTP 映射（API-GEN-005 脱敏输出）。
 *
 * job 模块当前无自有领域错误类型；任何执行异常统一兜底为 500
 * IFC-ERR-016（安全提交失败），不泄露内部细节。后续若引入领域错误，
 * 在此按 code 扩展映射即可。
 */

import { generateTraceId } from '../../../../platform/observability/domain/services/trace-id.generator';
import { IFC_ERROR_HTTP_STATUS } from '../../../../common/contracts/api-error';
import type { ApiErrorBody } from '../../../../common/contracts/api-error';

export interface ApiErrorResult {
  readonly ok: false;
  readonly status: number;
  readonly body: ApiErrorBody;
}

export function toApiError(error: unknown): ApiErrorResult {
  const supportId = generateTraceId();
  if (error instanceof Error) {
    // 预留：若将来抛出携带 IFC-ERR-* code 的结构化错误，可在此分支细化映射。
    void error.message;
  }
  return {
    ok: false,
    status: IFC_ERROR_HTTP_STATUS['IFC-ERR-016'],
    body: {
      code: 'IFC-ERR-016',
      message: '安全提交失败，请稍后重试',
      supportId,
    },
  };
}
