/**
 * 导出域应用层错误（5.4.2，映射到接口契约 IFC-ERR-*）。
 *
 * 错误码与 HTTP 状态对应表见 docs/specification/接口实现规格-v1.0.md §7。
 * 与 StatisticsAccessError 保持一致的形态，便于 HTTP 层统一映射。
 */

import { IFC_ERROR_HTTP_STATUS } from '../../../common/contracts/api-error';
import type { ApiErrorCode } from '../../../common/contracts/api-error';

/** 导出域应用层允许的错误码子集（含身份/状态/版本/安全开关） */
export type ExportErrorCode = Extract<
  ApiErrorCode,
  | 'IFC-ERR-002' // 高风险重新认证不足（超管用途导出）
  | 'IFC-ERR-003' // 当前无权（面试官批量/成员批量/非授权者删除/越权字段）
  | 'IFC-ERR-004' // 作用域不匹配（部门负责人越界/联合参与方不符）
  | 'IFC-ERR-005' // 输入无效/字段越界
  | 'IFC-ERR-006' // 业务前置条件失败（停用/联合失效/重认证过期）
  | 'IFC-ERR-007' // 状态冲突（非可重试/非可删除/终态）
  | 'IFC-ERR-008' // 版本/租约竞争
  | 'IFC-ERR-009' // 幂等冲突（同一幂等键语义不一致）
  | 'IFC-ERR-011' // 安全开关关闭（GOV-004）
  | 'IFC-ERR-015' // 结果不可见/不存在
>;

/** 导出访问错误：携带稳定 IFC 错误码和安全的可披露消息 */
export class ExportError extends Error {
  readonly code: ExportErrorCode;
  readonly httpStatus: number;

  constructor(code: ExportErrorCode, message: string) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
    this.httpStatus = IFC_ERROR_HTTP_STATUS[code];
  }
}

/** 便捷工厂 */
export const exportErrors = {
  reauth: (message: string) => new ExportError('IFC-ERR-002', message),
  forbidden: (message: string) => new ExportError('IFC-ERR-003', message),
  scopeMismatch: (message: string) => new ExportError('IFC-ERR-004', message),
  validation: (message: string) => new ExportError('IFC-ERR-005', message),
  precondition: (message: string) => new ExportError('IFC-ERR-006', message),
  stateConflict: (message: string) => new ExportError('IFC-ERR-007', message),
  versionConflict: (message: string) => new ExportError('IFC-ERR-008', message),
  conflict: (message: string) => new ExportError('IFC-ERR-009', message),
  safety: (message: string) => new ExportError('IFC-ERR-011', message),
  notVisible: (message: string) => new ExportError('IFC-ERR-015', message),
};
