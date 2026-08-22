/**
 * 统计域应用层错误（映射到接口契约 IFC-ERR-*）。
 *
 * 错误码与 HTTP 状态对应表见 docs/specification/接口实现规格-v1.0.md §7。
 */

import { IFC_ERROR_HTTP_STATUS } from '../../../common/contracts/api-error';
import type { ApiErrorCode } from '../../../common/contracts/api-error';

/** 统计域应用层允许的错误码子集 */
export type StatisticsErrorCode = Extract<
  ApiErrorCode,
  | 'IFC-ERR-003' | 'IFC-ERR-004' | 'IFC-ERR-005'
  | 'IFC-ERR-006' | 'IFC-ERR-015'
>;

/** 统计访问错误：携带稳定 IFC 错误码和安全的可披露消息 */
export class StatisticsAccessError extends Error {
  readonly code: StatisticsErrorCode;
  readonly httpStatus: number;

  constructor(code: StatisticsErrorCode, message: string) {
    super(message);
    this.name = 'StatisticsAccessError';
    this.code = code;
    this.httpStatus = IFC_ERROR_HTTP_STATUS[code];
  }
}

/** 便捷工厂 */
export const statisticsErrors = {
  forbidden: (message: string) =>
    new StatisticsAccessError('IFC-ERR-003', message),
  scopeMismatch: (message: string) =>
    new StatisticsAccessError('IFC-ERR-004', message),
  validation: (message: string) =>
    new StatisticsAccessError('IFC-ERR-005', message),
  precondition: (message: string) =>
    new StatisticsAccessError('IFC-ERR-006', message),
  notVisible: (message: string) =>
    new StatisticsAccessError('IFC-ERR-015', message),
};
