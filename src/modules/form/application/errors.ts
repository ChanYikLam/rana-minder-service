/**
 * 表单域应用命令错误（IFC-ERR-001~017 落地；接口实现规格 §7）。
 *
 * 传输层（interfaces）按 code 映射 HTTP 状态码；应用层只抛最小可披露错误。
 * 状态机守卫失败/业务拒绝在表单设计域统一 422 IFC-ERR-006（接口实现规格 §7 注、
 * 接口清单 §13.2：已发布不可覆盖/已停用 → 422）；版本/指针冲突 → 409 IFC-ERR-008；
 * 并发单胜者失败 → 409 IFC-ERR-010；幂等冲突 → 409 IFC-ERR-009。
 */

export const FormErrorCode = {
  UNAUTHENTICATED: 'IFC-ERR-001',
  REAUTH_REQUIRED: 'IFC-ERR-002',
  FORBIDDEN: 'IFC-ERR-003',
  SCOPE_MISMATCH: 'IFC-ERR-004',
  VALIDATION_FAILED: 'IFC-ERR-005',
  PRECONDITION_FAILED: 'IFC-ERR-006',
  STATE_CONFLICT: 'IFC-ERR-007',
  VERSION_CONFLICT: 'IFC-ERR-008',
  IDEMPOTENCY_CONFLICT: 'IFC-ERR-009',
  RESOURCE_CONTENTION: 'IFC-ERR-010',
  SECURITY_RESTRICTION: 'IFC-ERR-011',
  DEPENDENCY_UNAVAILABLE: 'IFC-ERR-012',
  EXTERNAL_UNKNOWN: 'IFC-ERR-013',
  PROCESSING: 'IFC-ERR-014',
  NOT_FOUND: 'IFC-ERR-015',
  SECURITY_COMMIT_FAILED: 'IFC-ERR-016',
  BAD_REQUEST: 'IFC-ERR-017',
} as const;
export type FormErrorCode = (typeof FormErrorCode)[keyof typeof FormErrorCode];

export class FormCommandError extends Error {
  constructor(
    readonly code: FormErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'FormCommandError';
  }
}

export const formErrors = {
  versionConflict(): FormCommandError {
    return new FormCommandError(FormErrorCode.VERSION_CONFLICT, '表单版本已变化，请刷新后重试');
  },
  resourceContention(message: string): FormCommandError {
    return new FormCommandError(FormErrorCode.RESOURCE_CONTENTION, message);
  },
  idempotencyConflict(): FormCommandError {
    return new FormCommandError(FormErrorCode.IDEMPOTENCY_CONFLICT, '相同幂等键对应不同请求内容');
  },
  forbidden(message: string): FormCommandError {
    return new FormCommandError(FormErrorCode.FORBIDDEN, message);
  },
  preconditionFailed(message: string): FormCommandError {
    return new FormCommandError(FormErrorCode.PRECONDITION_FAILED, message);
  },
  validationFailed(message: string, fieldErrors: Record<string, string[]>): FormCommandError {
    return new FormCommandError(FormErrorCode.VALIDATION_FAILED, message, { fieldErrors });
  },
  notFound(resource: string): FormCommandError {
    return new FormCommandError(FormErrorCode.NOT_FOUND, `${resource}不存在或不可见`);
  },
} as const;
