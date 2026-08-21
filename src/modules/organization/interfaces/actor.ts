/**
 * 请求主体解析（接口层占位）。
 *
 * 安全策略：
 * - `x-actor-id` 请求头可被任意客户端伪造，因此**绝对禁止**在任何非显式开启的
 *   开发环境以外信任该头。
 * - 生产环境（NODE_ENV=production）一律 fail-closed：拒绝直接信任请求头，必须由
 *   身份模块提供已认证主体。
 * - 本地开发/集成测试须显式设置 `ORG_DEV_ACTOR_HEADER=1` 才放行
 *   （与 observability status-page 桩口径一致：「可配置放行」）。
 */

import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { orgError } from '../domain/types';

export interface RequestActor {
  readonly userId: string;
}

const DEV_ACTOR_HEADER = 'x-actor-id';

function devActorHeaderEnabled(): boolean {
  // 生产环境绝对禁止信任可伪造的请求头（防超管身份伪造）。
  if (process.env['NODE_ENV'] === 'production') return false;
  // 占位仅在显式开启时可用，避免本地/集成环境之外的意外放行。
  return process.env['ORG_DEV_ACTOR_HEADER'] === '1';
}

export const Actor = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestActor => {
  const request = ctx.switchToHttp().getRequest<{ headers: Record<string, string | string[]> }>();
  if (!devActorHeaderEnabled()) {
    throw orgError.forbidden(
      '请求主体解析未接入身份模块；拒绝信任 x-actor-id 请求头（fail-closed，IFC-ERR-001）',
    );
  }
  const raw = request.headers[DEV_ACTOR_HEADER];
  const userId = Array.isArray(raw) ? raw[0] : raw;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw orgError.forbidden('缺少身份主体（x-actor-id）；身份模块接入前保持闭锁（fail-closed）');
  }
  return { userId };
});
