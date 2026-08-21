/**
 * 请求主体解析（接口层占位）。
 *
 * 安全策略：
 * - `x-actor-id` 请求头可被任意客户端伪造，因此**绝对禁止**在任何非显式开启的
 *   开发环境以外信任该头。
 * - 采用**反白名单**（fail-closed）：仅当 `NODE_ENV` 显式为 `development` 或 `test`
 *   且同时显式设置 `ORG_DEV_ACTOR_HEADER=1` 时才放行；其余任何环境
 *   （生产、staging、未设置 NODE_ENV 等）一律拒绝信任请求头，必须由身份模块
 *   提供已认证主体。
 * - 本地开发/集成测试须同时满足上述两个条件才放行
 *   （与 observability status-page 桩口径一致：「可配置放行」）。
 */

import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { orgError } from '../domain/types';

export interface RequestActor {
  readonly userId: string;
}

const DEV_ACTOR_HEADER = 'x-actor-id';

export const Actor = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestActor => {
  const request = ctx.switchToHttp().getRequest<{ headers: Record<string, string | string[]> }>();
  return resolveActorFromHeaders(request.headers);
});

export function resolveActorFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): RequestActor {
  if (!isDevActorHeaderEnabled(env)) {
    throw orgError.forbidden(
      '请求主体解析未接入身份模块；拒绝信任 x-actor-id 请求头（fail-closed，IFC-ERR-001）',
    );
  }
  const raw = headers[DEV_ACTOR_HEADER];
  const userId = Array.isArray(raw) ? raw[0] : raw;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw orgError.forbidden('缺少身份主体（x-actor-id）；身份模块接入前保持闭锁（fail-closed）');
  }
  return { userId };
}

function isDevActorHeaderEnabled(env: NodeJS.ProcessEnv): boolean {
  // 反白名单：仅显式声明为开发/测试环境才可能放行，避免生产漏设 NODE_ENV
  // 或值不标准时误信任可伪造的请求头（fail-closed）。
  const nodeEnv = env['NODE_ENV'];
  if (nodeEnv !== 'development' && nodeEnv !== 'test') return false;
  return env['ORG_DEV_ACTOR_HEADER'] === '1';
}
