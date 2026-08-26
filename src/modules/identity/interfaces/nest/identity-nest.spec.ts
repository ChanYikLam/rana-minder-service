/**
 * 身份模块 nest 接口层测试（P1 任务③；response-mapper + auth-session + guard）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { toHttpResponse, toActorContext } from './response-mapper';
import { RejectAllAuthSessionProvider, type AuthSession } from './auth-session';

const NOW = new Date('2026-08-01T00:00:00Z');

describe('toHttpResponse（API-GEN-004）', () => {
  it('成功路径：{ ok: true, value } → { code: 0, data: value }', () => {
    const r = toHttpResponse({ ok: true, value: { id: 'x' } });
    assert.deepEqual(r, { code: 0, data: { id: 'x' } });
  });

  it('错误路径：{ ok: false, status, body } → HttpException', () => {
    assert.throws(
      () =>
        toHttpResponse({
          ok: false,
          status: 403,
          body: { code: 'IFC-ERR-002', message: 'forbidden' },
        } as never),
      (e: unknown) => {
        const httpErr = e as { status?: number; response?: { code?: string } };
        return httpErr.status === 403 && httpErr.response?.code === 'IFC-ERR-002';
      },
    );
  });
});

describe('toActorContext（AUT 分面）', () => {
  it('从会话构造 ActorContext：subjectId 来自会话而非请求方自报', () => {
    const session: AuthSession = {
      subjectId: 'u_real',
      now: NOW,
      mailCapable: true,
    };
    const ctx = toActorContext(session, 'trace-123');
    assert.equal(ctx.subjectId, 'u_real');
    assert.equal(ctx.traceId, 'trace-123');
    assert.equal(ctx.mailCapable, true);
  });

  it('traceId 缺失时自动生成', () => {
    const ctx = toActorContext({ subjectId: 'u1', now: NOW }, null);
    assert.ok(ctx.traceId && ctx.traceId.length > 0);
  });

  it('mailCapable 缺省 → false（安全保守）', () => {
    const ctx = toActorContext({ subjectId: 'u1', now: NOW }, null);
    assert.equal(ctx.mailCapable, false);
  });
});

describe('RejectAllAuthSessionProvider（fail-closed）', () => {
  it('resolveSession 一律返回 null（未认证 → 守卫 401）', async () => {
    const provider = new RejectAllAuthSessionProvider();
    const r = await provider.resolveSession({ headers: {} } as never);
    assert.equal(r, null);
  });
});

// ---- AuthGuard 真实行为测试（评审 warning①：补齐未认证→401/已认证→挂载会话）----

import { AuthGuard, AUTH_SESSION_KEY } from './auth.guard';
import type { AuthSessionProvider } from './auth-session';

function makeMockContext(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as never;
}

const mockTrace = { current: () => ({ traceId: 'trace-guard-test' }) } as never;

describe('AuthGuard 行为级测试（评审 warning①）', () => {
  it('未认证：session=null → 抛 HttpException 401 IFC-ERR-001', async () => {
    const sessions: AuthSessionProvider = {
      resolveSession: async () => null,
    };
    const guard = new AuthGuard(sessions, mockTrace);
    const request = {};
    await assert.rejects(
      () => guard.canActivate(makeMockContext(request)),
      (e: unknown) => {
        const httpErr = e as { status?: number; response?: { code?: string; message?: string } };
        return (
          httpErr.status === 401 &&
          httpErr.response?.code === 'IFC-ERR-001' &&
          typeof httpErr.response?.message === 'string'
        );
      },
    );
  });

  it('已认证：canActivate 返回 true + 会话挂载到 request.authSession', async () => {
    const session: AuthSession = { subjectId: 'u_test', now: NOW };
    const sessions: AuthSessionProvider = {
      resolveSession: async () => session,
    };
    const guard = new AuthGuard(sessions, mockTrace);
    const request: Record<string, unknown> = {};
    const result = await guard.canActivate(makeMockContext(request));
    assert.equal(result, true);
    // 会话已挂载到 request 上，后续 controller/sessionFromRequest 可读取
    const mounted = request[AUTH_SESSION_KEY] as AuthSession;
    assert.ok(mounted);
    assert.equal(mounted.subjectId, 'u_test');
  });

  it('sessionFromRequest：从挂载后的请求中提取 subjectId', async () => {
    const session: AuthSession = { subjectId: 'u_extract', now: NOW };
    const sessions: AuthSessionProvider = { resolveSession: async () => session };
    const guard = new AuthGuard(sessions, mockTrace);
    const request: Record<string, unknown> = {};
    await guard.canActivate(makeMockContext(request));
    // 使用守卫导出的辅助函数验证挂载结果
    const { sessionFromRequest } = await import('./auth.guard');
    const extracted = sessionFromRequest(request);
    assert.equal(extracted.subjectId, 'u_extract');
  });
});
