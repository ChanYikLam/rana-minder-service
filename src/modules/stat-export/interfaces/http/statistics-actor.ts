/**
 * 统计控制器请求主体解析（接口层占位，与组织模块 actor.ts 口径一致）。
 *
 * 安全策略（fail-closed）：
 * - `x-actor-id` 请求头可被任意客户端伪造，因此**绝对禁止**在任何非显式开启的
 *   开发环境以外信任该头。
 * - 采用**反白名单**（fail-closed）：仅当 `NODE_ENV` 显式为 `development` 或 `test`
 *   且同时显式设置 `ORG_DEV_ACTOR_HEADER=1` 时才放行（与组织模块共用同一头）。
 * - 其余任何环境一律拒绝信任请求头，必须由身份模块提供已认证主体。
 */

import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

export interface RequestActor {
  readonly userId: string;
}

const DEV_ACTOR_HEADER = 'x-actor-id';

export const StatisticsActor = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): RequestActor => {
    const request = ctx.switchToHttp().getRequest<{ headers: Record<string, string | string[]> }>();
    return resolveActorFromHeaders(request.headers);
  },
);

export function resolveActorFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): RequestActor {
  if (!isDevActorHeaderEnabled(env)) {
    throw devActorError();
  }
  const raw = headers[DEV_ACTOR_HEADER];
  const userId = Array.isArray(raw) ? raw[0] : raw;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw devActorError();
  }
  return { userId };
}

function isDevActorHeaderEnabled(env: NodeJS.ProcessEnv): boolean {
  const nodeEnv = env['NODE_ENV'];
  if (nodeEnv !== 'development' && nodeEnv !== 'test') return false;
  return env['ORG_DEV_ACTOR_HEADER'] === '1';
}

function devActorError(): never {
  throw Object.assign(new Error('认证未接入，拒绝信任 x-actor-id（fail-closed，IFC-ERR-001）'), {
    status: 401,
    code: 'IFC-ERR-001',
  });
}
