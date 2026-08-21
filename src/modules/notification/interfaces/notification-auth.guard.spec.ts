/**
 * 通知认证守卫测试（评审 #2 IDOR：身份只来自服务端会话，
 * 未认证一律 401 fail-closed）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionContext, HttpException } from '@nestjs/common';
import type { Request } from 'express';

import {
  HeaderNotificationAuthSessionProvider,
  RejectAllNotificationAuthSessionProvider,
} from './notification-auth-session';
import {
  NotificationAuthGuard,
  NOTIFICATION_AUTH_SESSION_KEY,
  notificationSessionFromRequest,
} from './notification-auth.guard';

function mockContext(request: Partial<Request>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('NotificationAuthGuard（评审 #2：IDOR）', () => {
  it('默认 RejectAll：未认证请求 → 401 拒绝（fail-closed）', async () => {
    const guard = new NotificationAuthGuard(new RejectAllNotificationAuthSessionProvider());
    await assert.rejects(guard.canActivate(mockContext({})), (error: unknown) => {
      assert.ok(error instanceof HttpException);
      assert.equal((error as HttpException).getStatus(), 401);
      const body = (error as HttpException).getResponse() as { code: string };
      assert.equal(body.code, 'IFC-ERR-001');
      return true;
    });
  });

  it('已认证请求 → 放行并挂载会话（身份来自会话，非客户端自报）', async () => {
    const request = {
      headers: { 'x-user-id': 'session-user-1', 'x-user-name': '会话用户' },
    } as Partial<Request> & Record<string, unknown>;
    const guard = new NotificationAuthGuard(new HeaderNotificationAuthSessionProvider());
    const allowed = await guard.canActivate(mockContext(request));
    assert.equal(allowed, true);

    const session = notificationSessionFromRequest(request as Request);
    assert.equal(session.userId, 'session-user-1');
    assert.equal(session.displayName, '会话用户');
    assert.ok(request[NOTIFICATION_AUTH_SESSION_KEY]);
  });

  it('缺少身份头 → 401（HeaderProvider 也失败关闭）', async () => {
    const guard = new NotificationAuthGuard(new HeaderNotificationAuthSessionProvider());
    await assert.rejects(
      guard.canActivate(mockContext({ headers: {} })),
      (error: unknown) => error instanceof HttpException && error.getStatus() === 401,
    );
  });
});
