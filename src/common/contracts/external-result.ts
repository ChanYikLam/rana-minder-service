/**
 * 外部调用统一结果类型（ExternalResult / ExternalError）。
 *
 * 权威来源：docs/engineering/依赖外部适配边界（src/adapters/基础设施适配文档.md §公共类型）、
 * docs/specification/接口契约-v1.0.md（CAS-WR-*、CAS-REC-*）、ADR-004 §2.7、ADR-009。
 *
 * 约束：
 * - 适配器只报告规范化结果与错误分类；是否推进状态、创建角色或业务结论由领域模块决定。
 * - 外部结果不确定（UNCERTAIN）时必须先可信读回或查询，再决定成功、重试、补偿或异常；
 *   不得以 HTTP 成功、事件到达或本地期望值替代可信回读。
 * - 错误信息必须脱敏：不得包含业务正文、密钥、令牌或完整外部响应。
 */

/** 外部调用结果状态（与任务持久状态 TaskStatus 语义不同，不得混用） */
export type ExternalStatus =
  | 'SUCCESS'
  | 'UNCERTAIN'
  | 'RETRYABLE_FAILURE'
  | 'NON_RETRYABLE'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PARTIAL'
  | 'UNAVAILABLE';

export interface ExternalError {
  /** 稳定错误分类（脱敏，可安全披露） */
  readonly code: string;
  /** 脱敏错误摘要，不含业务正文/密钥/令牌 */
  readonly message: string;
  /** 是否建议重试 */
  readonly retryable: boolean;
  /** 原始 HTTP 状态码，仅用于诊断 */
  readonly rawStatusCode: number | null;
}

export interface ExternalResult<T> {
  readonly status: ExternalStatus;
  /** 成功时的规范化返回数据（含当前值、版本/时间依据） */
  readonly data: T | null;
  readonly error: ExternalError | null;
  /** 本次尝试的唯一标识（与业务幂等键、追踪编号分离） */
  readonly attemptId: string;
  readonly timestamp: Date;
}

export function externalSuccess<T>(
  data: T,
  attemptId: string,
  timestamp: Date = new Date(),
): ExternalResult<T> {
  return { status: 'SUCCESS', data, error: null, attemptId, timestamp };
}

export function externalFailure<T = never>(
  status: Exclude<ExternalStatus, 'SUCCESS'>,
  error: ExternalError,
  attemptId: string,
  timestamp: Date = new Date(),
): ExternalResult<T> {
  return { status, data: null, error, attemptId, timestamp };
}
