/**
 * joint 领域错误（domain 层；与 application/errors 同构，供领域模型抛出
 * 业务校验错误，避免原始 Error 被映射为 500）。
 */

export class JointDomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'JointDomainError';
  }
}
