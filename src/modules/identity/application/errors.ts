/**
 * 身份域应用命令错误（IFC-ERR-001~017 落地；接口实现规格 §7）。
 *
 * 传输层（interfaces）按 code 映射 HTTP 状态码；应用层只抛最小可披露错误，
 * 不携带敏感字段、完整个人资料或外部响应。
 */

export const IdentityErrorCode = {
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
export type IdentityErrorCode = (typeof IdentityErrorCode)[keyof typeof IdentityErrorCode];

export class IdentityCommandError extends Error {
  constructor(
    readonly code: IdentityErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'IdentityCommandError';
  }
}

export const identityErrors = {
  versionConflict(): IdentityCommandError {
    return new IdentityCommandError(
      IdentityErrorCode.VERSION_CONFLICT,
      '资料版本已变化，请刷新后重试',
    );
  },
  preconditionFailed(message: string): IdentityCommandError {
    return new IdentityCommandError(IdentityErrorCode.PRECONDITION_FAILED, message);
  },
  validationFailed(message: string, details?: Record<string, unknown>): IdentityCommandError {
    return new IdentityCommandError(IdentityErrorCode.VALIDATION_FAILED, message, details);
  },
  notFound(resource: string): IdentityCommandError {
    return new IdentityCommandError(IdentityErrorCode.NOT_FOUND, `${resource}不存在或不可见`);
  },
  externalUnknown(message: string): IdentityCommandError {
    return new IdentityCommandError(IdentityErrorCode.EXTERNAL_UNKNOWN, message);
  },
} as const;
