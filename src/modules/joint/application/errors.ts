/**
 * joint 应用层错误工厂（application；与 recruitment 同构）。
 *
 * 抛出 JointDomainError（code 见下）；接口层按其 code 映射 HTTP 状态：
 * JNT_FORBIDDEN→403、JNT_NOT_FOUND→404、JNT_CONFLICT→409、JNT_PRECONDITION→409、JNT_VALIDATION→400。
 * 仓储乐观锁未命中抛 JointConflictError（同映射 409）。
 */

import { JointDomainError } from '../domain/errors';

export const jointErrors = {
  forbidden(message: string, details?: unknown): never {
    throw new JointDomainError('JNT_FORBIDDEN', message, details);
  },
  notFound(target: string): never {
    throw new JointDomainError('JNT_NOT_FOUND', `${target}不存在或无权访问`);
  },
  conflict(message: string): never {
    throw new JointDomainError('JNT_CONFLICT', message);
  },
  preconditionFailed(message: string): never {
    throw new JointDomainError('JNT_PRECONDITION', message);
  },
  validation(message: string, details?: unknown): never {
    throw new JointDomainError('JNT_VALIDATION', message, details);
  },
};
