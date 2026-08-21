/**
 * Casdoor 适配层规范化结果（CAS-READ、CAS-FAIL-005）。
 *
 * 与后台任务模块的 ExternalStatus 不同：这里按 ADR-009 / Casdoor 集成契约
 * 区分“可信当前值 / 最近可信但过期观测 / 不存在 / 不唯一 / 部分结果 /
 * 依赖不可用 / 响应不确定”七类，并保留当前值、版本/时间依据和脱敏错误分类。
 */

export const ExternalStatus = {
  TRUSTED_CURRENT: 'TRUSTED_CURRENT',
  STALE_OBSERVATION: 'STALE_OBSERVATION',
  NOT_FOUND: 'NOT_FOUND',
  NOT_UNIQUE: 'NOT_UNIQUE',
  PARTIAL: 'PARTIAL',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  UNCERTAIN: 'UNCERTAIN',
} as const;

export type ExternalStatus = (typeof ExternalStatus)[keyof typeof ExternalStatus];

export const ExternalErrorKind = {
  NOT_FOUND: 'NOT_FOUND',
  NOT_UNIQUE: 'NOT_UNIQUE',
  TIMEOUT: 'TIMEOUT',
  CONNECTION_RESET: 'CONNECTION_RESET',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  UNCERTAIN: 'UNCERTAIN',
} as const;

export type ExternalErrorKind = (typeof ExternalErrorKind)[keyof typeof ExternalErrorKind];

export interface ExternalError {
  readonly kind: ExternalErrorKind;
  /** 脱敏后的稳定错误码，不得包含原始响应、令牌、Cookie 或人员敏感字段。 */
  readonly code: string;
  /** 面向调用者的安全摘要，可含可否重试提示，不回显完整外部响应。 */
  readonly message: string;
  readonly retryable: boolean;
  readonly trackingId: string;
}

export interface EvidenceRef {
  /** 外部对象版本/变更标识；未验证能力时可为空，但不允许把空当“无变化”。 */
  readonly version?: string;
  /** 观测时间（服务端收到可信响应的时间）。 */
  readonly observedAt: string;
  /** 来源实例/环境标识。 */
  readonly instance?: string;
  /** 尝试标识，关联写后读回（CAS-REC-001）。 */
  readonly attemptId?: string;
  /** 可选：对账运行编号（CAS-REC-005）。 */
  readonly runId?: string;
}

export interface ExternalResult<T> {
  readonly status: ExternalStatus;
  /** 可信当前值；STALE_OBSERVATION 时是最近可信旧观测；其余为 null。 */
  readonly value: T | null;
  readonly evidence: EvidenceRef;
  readonly error: ExternalError | null;
}

export function trustedCurrent<T>(
  value: T,
  evidence: EvidenceRef,
  error: ExternalError | null = null,
): ExternalResult<T> {
  return { status: ExternalStatus.TRUSTED_CURRENT, value, evidence, error };
}

export function staleObservation<T>(
  value: T,
  evidence: EvidenceRef,
  error: ExternalError | null = null,
): ExternalResult<T> {
  return { status: ExternalStatus.STALE_OBSERVATION, value, evidence, error };
}

export function notFound<T>(evidence: EvidenceRef, error?: ExternalError): ExternalResult<T> {
  return {
    status: ExternalStatus.NOT_FOUND,
    value: null,
    evidence,
    error: error ?? {
      kind: ExternalErrorKind.NOT_FOUND,
      code: 'CAS-ERR-NOT_FOUND',
      message: '目标在 Casdoor 中不存在',
      retryable: false,
      trackingId: evidence.attemptId ?? 'n/a',
    },
  };
}

export function notUnique<T>(
  evidence: EvidenceRef,
  detail = '匹配到多个候选，未证明唯一',
): ExternalResult<T> {
  return {
    status: ExternalStatus.NOT_UNIQUE,
    value: null,
    evidence,
    error: {
      kind: ExternalErrorKind.NOT_UNIQUE,
      code: 'CAS-ERR-NOT_UNIQUE',
      message: detail,
      retryable: false,
      trackingId: evidence.attemptId ?? 'n/a',
    },
  };
}

export function partial<T>(
  value: T,
  evidence: EvidenceRef,
  error?: ExternalError,
): ExternalResult<T> {
  return {
    status: ExternalStatus.PARTIAL,
    value,
    evidence,
    error: error ?? {
      kind: ExternalErrorKind.UNCERTAIN,
      code: 'CAS-ERR-PARTIAL',
      message: '仅获得部分结果，未证明完整',
      retryable: true,
      trackingId: evidence.attemptId ?? 'n/a',
    },
  };
}

export function unavailable<T>(evidence: EvidenceRef, error?: ExternalError): ExternalResult<T> {
  return {
    status: ExternalStatus.DEPENDENCY_UNAVAILABLE,
    value: null,
    evidence,
    error: error ?? {
      kind: ExternalErrorKind.DEPENDENCY_UNAVAILABLE,
      code: 'CAS-ERR-UNAVAILABLE',
      message: 'Casdoor 依赖当前不可用',
      retryable: true,
      trackingId: evidence.attemptId ?? 'n/a',
    },
  };
}

export function uncertain<T>(evidence: EvidenceRef, error?: ExternalError): ExternalResult<T> {
  return {
    status: ExternalStatus.UNCERTAIN,
    value: null,
    evidence,
    error: error ?? {
      kind: ExternalErrorKind.UNCERTAIN,
      code: 'CAS-ERR-UNCERTAIN',
      message: '响应不确定，需定向读回或重试',
      retryable: true,
      trackingId: evidence.attemptId ?? 'n/a',
    },
  };
}
