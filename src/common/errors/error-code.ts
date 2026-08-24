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
  // 高风险操作需重新认证（接口契约 IFC-ERR-002，HTTP 401）
  REAUTH_REQUIRED: 'IFC-ERR-002',
  // 作用域不匹配（IFC-ERR-004，HTTP 403）
  SCOPE_MISMATCH: 'IFC-ERR-004',
  // 业务前置条件失败（IFC-ERR-006，HTTP 422）
  PRECONDITION_FAILED: 'IFC-ERR-006',
  // 状态冲突（IFC-ERR-007，HTTP 409）
  STATE_CONFLICT: 'IFC-ERR-007',
  // 对象/预览/命令版本不匹配（IFC-ERR-008，HTTP 409）
  VERSION_CONFLICT: 'IFC-ERR-008',
  // 外部结果不确定（IFC-ERR-013，HTTP 502）
  EXTERNAL_UNKNOWN: 'IFC-ERR-013',
  // 结果不可见 / 不存在（IFC-ERR-015，HTTP 404）
  NOT_VISIBLE: 'IFC-ERR-015',
  // 内部提交失败（IFC-ERR-016，HTTP 500）
  COMMIT_FAILED: 'IFC-ERR-016',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
