/**
 * 通知认证守卫测试（评审 #2 IDOR：身份只来自服务端会话，
 * 未认证一律 401 fail-closed）。
 *
 * 注意：测试用会话桩（固定返回 session-user）仅存在于测试代码，
 * 生产代码不提供任何"信任客户端请求头"的会话实现（评审 #9）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionContext, HttpException } from '@nestjs/common';
import type { Request } from 'express';

import { RejectAllNotificationAuthSessionProvider } from './notification-auth-session';
import type { NotificationAuthSessionProvider } from './notification-auth-session';
import {
  NotificationAuthGuard,
  NOTIFICATION_AUTH_SESSION_KEY,
  notificationSessionFromRequest,
} from './notification-auth.guard';

/** 测试专用会话桩：固定返回已认证会话（仅测试代码使用） */
class FixedSessionAuthProvider implements NotificationAuthSessionProvider {
  async resolveSession(): Promise<{ userId: string; displayName: string; now: Date }> {
    return { userId: 'session-user-1', displayName: '会话用户', now: new Date() };
  }
}

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
    const request = {} as Partial<Request> & Record<string, unknown>;
    const guard = new NotificationAuthGuard(new FixedSessionAuthProvider());
    const allowed = await guard.canActivate(mockContext(request));
    assert.equal(allowed, true);

    const session = notificationSessionFromRequest(request as Request);
    assert.equal(session.userId, 'session-user-1');
    assert.equal(session.displayName, '会话用户');
    assert.ok(request[NOTIFICATION_AUTH_SESSION_KEY]);
  });

  it('会话解析返回 null → 401（fail-closed，不放过未认证请求）', async () => {
    const provider: NotificationAuthSessionProvider = {
      async resolveSession() {
        return null;
      },
    };
    const guard = new NotificationAuthGuard(provider);
    await assert.rejects(
      guard.canActivate(mockContext({})),
      (error: unknown) => error instanceof HttpException && error.getStatus() === 401,
    );
  });
});
