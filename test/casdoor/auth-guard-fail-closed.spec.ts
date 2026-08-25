/**
 * 认证守卫 fail-closed 测试（IFC-ERR-001 / API-GEN-005）。
 *
 * 契约锚点：
 * - 接口契约 `IFC-ERR-001`：未认证 → HTTP 401，错误体**只含**
 *   {code, message, supportId} 三字段（API-GEN-005 最小披露）；
 * - `CAS-CAP-003` / `CAS-FAIL-001`：无法可信确认会话时失败关闭，不猜测主体；
 * - supportId 复用当前追踪上下文 traceId（与响应头 X-Trace-Id 一致），
 *   无上下文时回退 generateTraceId()；
 * - 有会话时挂载 request.authSession（subjectId 恒来自服务端认证结果，AUT）。
 *
 * 被测：AuthGuard + RejectAllAuthSessionProvider（auth-session.ts fail-closed 桩）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';

import { AuthGuard, sessionFromRequest } from '../../src/modules/identity/interfaces/nest/auth.guard';
import {
  RejectAllAuthSessionProvider,
  type AuthSession,
  type AuthSessionProvider,
} from '../../src/modules/identity/interfaces/nest/auth-session';
import { createTraceContextAdapter } from '../../src/platform/observability/infrastructure/trace-context.adapter';
import { isTraceId } from '../../src/platform/observability/domain/services/trace-id.generator';

function fakeExecutionContext(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
  } as never;
}

describe('RejectAllAuthSessionProvider（fail-closed 基线桩）', () => {
  it('任意请求一律解析为 null（不抛出、不猜测主体）', async () => {
    const provider = new RejectAllAuthSessionProvider();
    assert.equal(await provider.resolveSession({ headers: {} } as unknown as Request), null);
    assert.equal(await provider.resolveSession({} as unknown as Request), null);
  });
});

describe('AuthGuard 未认证 → 401 IFC-ERR-001（体形状 API-GEN-005）', () => {
  it('RejectAll 会话源 → canActivate 拒绝并抛 HttpException 401', async () => {
    const guard = new AuthGuard(new RejectAllAuthSessionProvider(), createTraceContextAdapter());
    await assert.rejects(
      guard.canActivate(fakeExecutionContext({})),
      (error: unknown) => error instanceof Error && error.constructor.name === 'HttpException',
    );
  });

  it('401 错误体恰为 {code, message, supportId} 三字段，code=IFC-ERR-001', async () => {
    const guard = new AuthGuard(new RejectAllAuthSessionProvider(), createTraceContextAdapter());
    await assert.rejects(
      guard.canActivate(fakeExecutionContext({})),
      (error: unknown) => {
        if (
          error === null ||
          typeof error !== 'object' ||
          !('getStatus' in error) ||
          typeof (error as { getStatus: unknown }).getStatus !== 'function'
        ) {
          return false;
        }
        const httpError = error as { getStatus(): number; getResponse(): unknown };
        const body = httpError.getResponse() as Record<string, unknown>;
        return (
          httpError.getStatus() === 401 &&
          body['code'] === 'IFC-ERR-001' &&
          typeof body['message'] === 'string' &&
          body['message'].length > 0 &&
          typeof body['supportId'] === 'string' &&
          Object.keys(body).length === 3
        );
      },
    );
  });

  it('无活跃追踪上下文 → supportId 回退为新生成 traceId（tr_ 前缀格式合法）', async () => {
    const guard = new AuthGuard(new RejectAllAuthSessionProvider(), createTraceContextAdapter());
    await assert.rejects(guard.canActivate(fakeExecutionContext({})), (error: unknown) => {
      const body = (error as { getResponse(): Record<string, unknown> }).getResponse();
      return typeof body['supportId'] === 'string' && isTraceId(body['supportId']);
    });
  });

  it("supportId 复用当前追踪上下文的 traceId（与 X-Trace-Id 一致；CAS-SEC-004 最少关联追踪编号）", async () => {
    const trace = createTraceContextAdapter();
    const guard = new AuthGuard(new RejectAllAuthSessionProvider(), trace);
    // 校验必须在 ALS 上下文内取样：assert.rejects 的验证函数运行于上下文之外，
    //彼时 trace.current() 已不可用。故在 runWithNewRoot 内捕获 supportId 与 ctxTraceId。
    const observed: { supportId?: unknown; ctxTraceId?: string } = {};
    const attempt = trace.runWithNewRoot(async (): Promise<never> => {
      try {
        await guard.canActivate(fakeExecutionContext({}));
      } catch (error) {
        observed.supportId = (
          error as { getResponse(): Record<string, unknown> }
        ).getResponse()['supportId'];
        observed.ctxTraceId = trace.current()?.traceId;
      }
      throw new Error('guard-rejection-recorded');
    });
    await assert.rejects(attempt, /guard-rejection-recorded/);
    assert.ok(typeof observed.ctxTraceId === 'string' && isTraceId(observed.ctxTraceId));
    assert.equal(observed.supportId, observed.ctxTraceId);
  });

  it('拒绝时不向 request 写入任何会话痕迹（fail-closed 不留半状态）', async () => {
    const guard = new AuthGuard(new RejectAllAuthSessionProvider(), createTraceContextAdapter());
    const request: Record<string, unknown> = {};
    await assert.rejects(guard.canActivate(fakeExecutionContext(request)));
    assert.equal('authSession' in request, false);
    assert.equal(sessionFromRequest(request), undefined);
  });
});

describe('AuthGuard 已认证 → 放行并挂载 request.authSession', () => {
  const session: AuthSession = {
    subjectId: 'u_20240001',
    now: new Date('2026-08-25T08:00:00.000Z'),
  };

  function stubSessionProvider(returned: AuthSession | null): AuthSessionProvider {
    return { resolveSession: async () => returned };
  }

  it('会话存在 → canActivate=true，request.authSession 挂载同一 subjectId', async () => {
    const guard = new AuthGuard(stubSessionProvider(session), createTraceContextAdapter());
    const request: Record<string, unknown> = {};
    assert.equal(await guard.canActivate(fakeExecutionContext(request)), true);
    const mounted = sessionFromRequest(request);
    assert.ok(mounted);
    assert.equal(mounted.subjectId, 'u_20240001');
    assert.equal(mounted.now.getTime(), Date.parse('2026-08-25T08:00:00.000Z'));
  });

  it("AUT 分面：请求方自报身份头不被采纳——挂载值只来自会话源", async () => {
    const guard = new AuthGuard(stubSessionProvider(session), createTraceContextAdapter());
    // 攻击者伪造 x-subjected-user 头试图冒充他人
    const request: Record<string, unknown> = { headers: { 'x-subjected-user': 'victim' } };
    await guard.canActivate(fakeExecutionContext(request));
    assert.equal((sessionFromRequest(request) as AuthSession).subjectId, 'u_20240001');
  });

  it('会话源返回 null（如降级窗口过期）→ 仍然 401，即使带了伪造身份头', async () => {
    const guard = new AuthGuard(stubSessionProvider(null), createTraceContextAdapter());
    const request: Record<string, unknown> = {
      headers: { authorization: 'Bearer forged-token' },
    };
    await assert.rejects(guard.canActivate(fakeExecutionContext(request)));
    assert.equal('authSession' in request, false);
  });
});
