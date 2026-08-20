/**
 * Nest HTTP 适配层（interfaces/nest）单元测试。
 *
 * 覆盖：
 * - AuthGuard：未认证 → 401 IFC-ERR-001（错误响应只含 code/message/supportId）；
 *   认证成功 → request.authSession 挂载；
 * - 响应映射：{ok:true} → HTTP 200 {code:0,data}；{ok:false} → 原样 HttpException；
 * - AUT：subjectId 恒来自会话，请求方身份不被采纳；
 * - traceId：ActorContext.traceId 取自追踪上下文。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionContext, HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { createTraceContextAdapter, type TraceContextAdapter } from '../../../../platform/observability/infrastructure/trace-context.adapter';
import { TRACE_CONTEXT } from '../../../../platform/observability/tracing/tokens';

import { AuthGuard } from './auth.guard';
import { ProfilesNestController } from './profiles.nest.controller';
import { AccountAccessNestController } from './account-access.nest.controller';
import type { AuthSession, AuthSessionProvider } from './auth-session';
import { PROFILES_CONTROLLER, ACCOUNT_ACCESS_CONTROLLER, AUTH_SESSION_PROVIDER } from '../../tokens';
import type { ProfilesController, MyProfileResponse, ActorContext } from '../controllers/profiles.controller';
import type { AccountAccessController, SessionResponse } from '../controllers/account-access.controller';
import type { ApiErrorResult } from '../http/error-http';

const session: AuthSession = { subjectId: 'user-1', now: new Date('2026-08-20T12:00:00.000Z') };

function fixedSessionProvider(sessionOrNull: AuthSession | null): AuthSessionProvider {
  return { async resolveSession() { return sessionOrNull; } };
}

function fakeExecutionContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

describe('AuthGuard（IFC-ERR-001 未认证 401）', () => {
  it('会话解析失败 → 401 IFC-ERR-001（失败关闭），不猜测主体', async () => {
    const guard = new AuthGuard(fixedSessionProvider(null), createTraceContextAdapter());
    await assert.rejects(
      guard.canActivate(fakeExecutionContext({})),
      (error: unknown) =>
        error instanceof HttpException &&
        error.getStatus() === 401 &&
        (error.getResponse() as { code: string }).code === 'IFC-ERR-001' &&
        typeof (error.getResponse() as { supportId: string }).supportId === 'string' &&
        Object.keys(error.getResponse() as object).length === 3,
    );
  });

  it('会话成功 → 挂载 request.authSession 并放行', async () => {
    const guard = new AuthGuard(fixedSessionProvider(session), createTraceContextAdapter());
    const request: Record<string, unknown> = {};
    assert.equal(await guard.canActivate(fakeExecutionContext(request)), true);
    assert.equal((request['authSession'] as AuthSession).subjectId, 'user-1');
  });
});

describe('ProfilesNestController（API-AUTH-002 传输落地）', () => {
  async function buildController(plain: ProfilesController) {
    const module = await Test.createTestingModule({
      controllers: [ProfilesNestController, AccountAccessNestController],
      providers: [
        AuthGuard,
        { provide: AUTH_SESSION_PROVIDER, useValue: fixedSessionProvider(session) },
        { provide: PROFILES_CONTROLLER, useValue: plain },
        { provide: ACCOUNT_ACCESS_CONTROLLER, useValue: fakeAccountAccess() },
        { provide: TRACE_CONTEXT, useValue: createTraceContextAdapter() },
      ],
    }).compile();
    return {
      profiles: module.get(ProfilesNestController),
      trace: module.get<TraceContextAdapter>(TRACE_CONTEXT),
    };
  }

  it('成功 → HTTP 200 { code:0, data }，actor 来自会话与追踪上下文', async () => {
    const received: unknown[] = [];
    const profileView: MyProfileResponse = {
      version: 3,
      studentId: '20240001',
      name: '张三',
      email: 'a@example.com',
      phone: null,
      emailVerified: true,
      profileComplete: true,
      syncStatus: { phone: 'SYNCED' },
    };
    const plain: ProfilesController = {
      async getMyProfile(actor: ActorContext) {
        received.push(actor);
        return { ok: true, value: profileView };
      },
    } as unknown as ProfilesController;
    const { profiles, trace } = await buildController(plain);

    const result = trace.runWithNewRoot(() =>
      profiles.getMyProfile({ authSession: session }),
    );

    assert.deepEqual(await result, { code: 0, data: profileView });
    const actor = received[0] as { subjectId: string; traceId: string };
    assert.equal(actor.subjectId, 'user-1'); // AUT：恒来自会话
    assert.match(actor.traceId, /^tr_/);
  });

  it('信封 body 原样透传（业务字段只读 input，解析在传输中立控制器）', async () => {
    const bodies: unknown[] = [];
    const plain: ProfilesController = {
      async saveMyProfile(_actor: ActorContext, body: unknown) {
        bodies.push(body);
        return { ok: true, value: null as never };
      },
    } as unknown as ProfilesController;
    const { profiles } = await buildController(plain);
    const body = { input: { phone: '139' }, expectedVersion: 3 };

    await profiles.saveMyProfile({ authSession: session }, body);

    assert.equal(bodies[0], body);
  });

  it('拒绝 → 原样 HttpException（409 IFC-ERR-008 + currentData）', async () => {
    const errorResult: ApiErrorResult = {
      ok: false,
      status: 409,
      body: {
        code: 'IFC-ERR-008',
        message: '版本冲突',
        supportId: 'tr-1',
        ...{ currentData: { email: 'a@example.com', phone: '139' } },
      },
    };
    const plain: ProfilesController = {
      async saveMyProfile() {
        return errorResult;
      },
    } as unknown as ProfilesController;
    const { profiles } = await buildController(plain);

    await assert.rejects(
      profiles.saveMyProfile({ authSession: session }, {}),
      (error: unknown) =>
        error instanceof HttpException &&
        error.getStatus() === 409 &&
        (error.getResponse() as { code: string }).code === 'IFC-ERR-008' &&
        (error.getResponse() as { currentData: { phone: string } }).currentData.phone === '139',
    );
  });

  it('verify-email 例外（422 IFC-ERR-007 + fieldErrors.code）经传输层原样透传', async () => {
    const errorResult: ApiErrorResult = {
      ok: false,
      status: 422,
      body: { code: 'IFC-ERR-007', message: '验证码错误或过期', supportId: 'tr-2', fieldErrors: { code: ['错误或过期'] } },
    };
    const plain: ProfilesController = {
      async verifyEmail() {
        return errorResult;
      },
    } as unknown as ProfilesController;
    const { profiles } = await buildController(plain);

    await assert.rejects(
      profiles.verifyEmail({ authSession: session }, {}),
      (error: unknown) =>
        error instanceof HttpException &&
        error.getStatus() === 422 &&
        (error.getResponse() as { fieldErrors: { code: string[] } }).fieldErrors.code[0] === '错误或过期',
    );
  });
});

describe('AccountAccessNestController（GET /api/auth/session）', () => {
  it('成功 → { code:0, data }（本人资料 + 账号访问状态）', async () => {
    const sessionView: SessionResponse = {
      profile: { version: 1, studentId: null, name: null, email: null, phone: null, emailVerified: false, profileComplete: false, syncStatus: {} },
      accountAccess: { state: 'ACTIVE', degraded: false, degradedSince: null, remainingWindowMs: 0 },
    };
    const plain: AccountAccessController = {
      async getSession() {
        return { ok: true, value: sessionView };
      },
    } as unknown as AccountAccessController;
    const module = await Test.createTestingModule({
      controllers: [AccountAccessNestController],
      providers: [
        AuthGuard,
        { provide: AUTH_SESSION_PROVIDER, useValue: fixedSessionProvider(session) },
        { provide: ACCOUNT_ACCESS_CONTROLLER, useValue: plain },
        { provide: TRACE_CONTEXT, useValue: createTraceContextAdapter() },
      ],
    }).compile();
    const controller = module.get(AccountAccessNestController);

    assert.deepEqual(await controller.getSession({ authSession: session }), {
      code: 0,
      data: sessionView,
    });
  });
});

function fakeAccountAccess(): AccountAccessController {
  return {
    async getSession(): Promise<{ ok: true; value: SessionResponse } | ApiErrorResult> {
      return {
        ok: true,
        value: {
          profile: { version: 1, studentId: null, name: null, email: null, phone: null, emailVerified: false, profileComplete: false, syncStatus: {} },
          accountAccess: { state: 'ACTIVE', degraded: false, degradedSince: null, remainingWindowMs: 0 },
        },
      };
    },
    async checkAccess(): Promise<{ ok: true; value: { allowed: boolean; degraded: boolean; reason: string | null } } | ApiErrorResult> {
      return { ok: true, value: { allowed: false, degraded: false, reason: null } };
    },
  } as unknown as AccountAccessController;
}