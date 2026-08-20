/**
 * 请求主体解析（接口层占位）。
 *
 * 身份与会话模块接入前，通过 `x-actor-id` 请求头解析主体标识；任何真实环境必须
 * 由身份模块提供已认证主体（fail-closed：解析不到时抛 401）。该占位仅在
 * 本地开发/集成测试中可配置放行（与 observability status-page 桩口径一致）。
 */

import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { orgError } from '../domain/types';

export interface RequestActor {
  readonly userId: string;
}

export const Actor = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestActor => {
  const request = ctx.switchToHttp().getRequest<{ headers: Record<string, string | string[]> }>();
  const raw = request.headers['x-actor-id'];
  const userId = Array.isArray(raw) ? raw[0] : raw;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw orgError.forbidden('缺少身份主体（x-actor-id）；身份模块接入前保持闭锁（fail-closed）');
  }
  return { userId };
});
