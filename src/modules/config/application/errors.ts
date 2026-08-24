/**
 * config 应用层错误（config 应用层；与 recruitment errors 同构，基于领域错误派生，
 * 便于接口层按 code 统一映射 HTTP 状态）。
 */

import { ConfigDomainError } from '../domain/errors';

export class ConfigError extends ConfigDomainError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, details);
    this.name = 'ConfigError';
  }
}

export const cfgErrors = {
  forbidden: (message = '无权执行该配置操作') => new ConfigError('CFG_FORBIDDEN', message),
  notFound: (target = '展示资料') => new ConfigError('CFG_NOT_FOUND', `${target}不存在`),
  preconditionFailed: (message: string) => new ConfigError('CFG_PRECONDITION', message),
  conflict: (message: string) => new ConfigError('CFG_CONFLICT', message),
  versionConflict: (message = '展示资料已被他人修改，请刷新后重试') =>
    new ConfigError('CFG_VERSION_CONFLICT', message),
  validation: (message: string, details?: unknown) =>
    new ConfigError('CFG_VALIDATION', message, details),
};
