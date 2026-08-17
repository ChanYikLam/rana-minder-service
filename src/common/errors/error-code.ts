/**
 * 应用错误码（IFC-ERR-*）。
 *
 * 权威语义以《接口契约 v1.0》错误分类与错误脱敏要求为准；
 * 此处先冻结派生/查询侧最小编码，其余随各模块实现补齐。
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'IFC-ERR-VALIDATION',
  NOT_FOUND: 'IFC-ERR-NOT_FOUND',
  FORBIDDEN: 'IFC-ERR-FORBIDDEN',
  CONFLICT: 'IFC-ERR-CONFLICT',
  DERIVED_STALE: 'IFC-ERR-DERIVED_STALE',
  DERIVED_UNAVAILABLE: 'IFC-ERR-DERIVED_UNAVAILABLE',
  INTERNAL: 'IFC-ERR-INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
