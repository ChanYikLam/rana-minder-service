/**
 * 通知认证守卫（interfaces/nest；IFC-ERR-001 未认证 401）。
 *
 * 每次受保护请求解析会话并挂载 request.notificationAuthSession；
 * 未认证 → 401 IFC-ERR-001。所有 /api/notifications* 与站内信紧急关闭
 * 端点都必须经过本守卫，身份只来自服务端会话，杜绝越权指定他人
 * userId/operatorId（IDOR）。
 */

import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

import { NOTIFICATION_AUTH_SESSION_PROVIDER } from '../tokens';
import type {
  NotificationAuthSession,
  NotificationAuthSessionProvider,
} from './notification-auth-session';

export const NOTIFICATION_AUTH_SESSION_KEY = 'notificationAuthSession';

@Injectable()
export class NotificationAuthGuard implements CanActivate {
  constructor(
    @Inject(NOTIFICATION_AUTH_SESSION_PROVIDER)
    private readonly sessions: NotificationAuthSessionProvider,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const session = await this.sessions.resolveSession(request);
    if (session === null) {
      throw new HttpException(
        { code: 'IFC-ERR-001', message: '未认证或认证失效', supportId: null },
        HttpStatus.UNAUTHORIZED,
      );
    }
    (request as Request & Record<string, unknown>)[NOTIFICATION_AUTH_SESSION_KEY] = session;
    return true;
  }
}

export function notificationSessionFromRequest(request: Request): NotificationAuthSession {
  return (request as Request & Record<string, unknown>)[
    NOTIFICATION_AUTH_SESSION_KEY
  ] as NotificationAuthSession;
}
