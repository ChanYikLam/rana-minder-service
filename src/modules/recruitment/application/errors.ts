/**
 * 招新应用层错误（recruitment 应用层；与 form 模块 errors 同构）。
 */

import { RecruitmentDomainError } from '../domain/errors';

export class RecruitmentError extends RecruitmentDomainError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, details);
    this.name = 'RecruitmentError';
  }
}

export const recruitmentErrors = {
  forbidden: (message = '无权执行该招新操作') => new RecruitmentError('REC_FORBIDDEN', message),
  notFound: (target = '招新资源') => new RecruitmentError('REC_NOT_FOUND', `${target}不存在`),
  preconditionFailed: (message: string) => new RecruitmentError('REC_PRECONDITION', message),
  conflict: (message: string) => new RecruitmentError('REC_CONFLICT', message),
  validation: (message: string, details?: unknown) =>
    new RecruitmentError('REC_VALIDATION', message, details),
};
