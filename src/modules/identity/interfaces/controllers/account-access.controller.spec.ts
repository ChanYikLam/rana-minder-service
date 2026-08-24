/**
 * AccountAccessController 单元测试（接口层；接口清单 §4 GET /api/auth/session、
 * SRS-FAIL-001 降级期间能力判定）。
 *
 * 分面：
 * - NOM：会话聚合本人资料 + 账号访问状态；
 * - 降级：白名单类别放行、受保护业务拒绝、超窗拒绝、未可信会话拒绝；
 * - AUT：subjectId 恒来自会话；作用域不符（IFC-ERR-004）/禁用（IFC-ERR-011）
 *   等拒绝按 HTTP 403 透传。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AccountAccessController, type AccessCheckInput } from './account-access.controller';
import type { ActorContext } from './profiles.controller';
import type {
  GetMyProfileQuery,
  GetMyProfileResult,
} from '../../application/queries/get-my-profile.query';
import type {
  GetAccountAccessQuery,
  GetAccountAccessResult,
} from '../../application/queries/get-account-access.query';
import { IdentityCommandError, IdentityErrorCode } from '../../application/errors';
import type { IdentityUnitOfWork } from '../../infrastructure/unit-of-work';
import type { RlsScope } from '../../../../shared/db-adapter';

const uowStub = {
  run: async <T>(_scope: RlsScope, fn: () => Promise<T>) => fn(),
} as unknown as IdentityUnitOfWork;

const now = new Date('2026-08-20T12:00:00.000Z');
const degradedSince = new Date('2026-08-20T11:50:00.000Z'); // 窗口内（10 分钟）

function actor(overrides?: Partial<ActorContext>): ActorContext {
  return { subjectId: 'user-1', now, traceId: 'tr-1', ...overrides };
}

function myProfile(overrides?: Partial<GetMyProfileResult>): GetMyProfileResult {
  return {
    subjectId: 'user-1',
    version: 4,
    fields: { studentId: '20240001', name: '张三', phone: '13800000000' },
    emailVerified: true,
    verifiedEmail: null,
    pendingEmail: null,
    gateState: 'WRITABLE',
    restrictions: [],
    syncStatus: {},
    profileComplete: true,
    degraded: false,
    degradedSince: null,
    remainingWindowMs: 0,
    ...overrides,
  };
}

function access(overrides?: Partial<GetAccountAccessResult>): GetAccountAccessResult {
  return {
    state: 'ACTIVE',
    degraded: false,
    degradedSince: null,
    remainingWindowMs: 0,
    withinWindow: false,
    whitelistAllowed: true,
    reason: null,
    ...overrides,
  };
}

interface FakeQueries {
  profileCalls: { subjectId: string }[];
  accessCalls: Parameters<GetAccountAccessQuery['execute']>[0][];
  profileError: unknown;
  accessError: unknown;
}

const fakeQueries: FakeQueries = {
  profileCalls: [],
  accessCalls: [],
  profileError: null,
  accessError: null,
};

function createController(overrides?: {
  profile?: Partial<GetMyProfileResult>;
  access?: Partial<GetAccountAccessResult>;
}) {
  fakeQueries.profileError = null;
  fakeQueries.accessError = null;
  const fakeProfile: GetMyProfileQuery = {
    async execute(input) {
      fakeQueries.profileCalls.push({ subjectId: input.subjectId });
      if (fakeQueries.profileError !== null) {
        throw fakeQueries.profileError;
      }
      return myProfile(overrides?.profile);
    },
  };
  const fakeAccess: GetAccountAccessQuery = {
    async execute(input) {
      fakeQueries.accessCalls.push(input);
      if (fakeQueries.accessError !== null) {
        throw fakeQueries.accessError;
      }
      return access(overrides?.access);
    },
  };
  return new AccountAccessController(fakeProfile, fakeAccess, uowStub);
}

describe('AccountAccessController.getSession（GET /api/auth/session）', () => {
  it('NOM：聚合本人资料 + 账号访问状态', async () => {
    const controller = createController({
      profile: { degraded: true, degradedSince, remainingWindowMs: 300000 },
      access: {
        state: 'UNVERIFIABLE',
        degraded: true,
        degradedSince,
        remainingWindowMs: 300000,
      },
    });
    const result = await controller.getSession(actor());

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.profile.email, null); // 降级下仅基础字段
    assert.equal(result.value.accountAccess.degraded, true);
    assert.equal(result.value.accountAccess.remainingWindowMs, 300000);
  });

  it('AUT：会话聚合强制使用会话 subjectId', async () => {
    fakeQueries.profileCalls = [];
    fakeQueries.accessCalls = [];
    const controller = createController();
    await controller.getSession(actor({ subjectId: 'user-session' }));

    assert.equal(fakeQueries.profileCalls[0].subjectId, 'user-session');
    assert.equal(fakeQueries.accessCalls[0].subjectId, 'user-session');
  });

  it('AUT：账号禁用（IFC-ERR-011 语义）→ 403 透传', async () => {
    const controller = createController();
    fakeQueries.accessError = new IdentityCommandError(
      IdentityErrorCode.SECURITY_RESTRICTION,
      '账号已被禁用',
    );
    const result = await controller.getSession(actor());

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'IFC-ERR-011');
  });
});

describe('AccountAccessController.checkAccess（SRS-FAIL-001 逐请求判定）', () => {
  const input = (overrides?: Partial<AccessCheckInput>): AccessCheckInput => ({
    category: 'OWN_BASIC_PROFILE_READ',
    sessionAuthenticatedBeforeFailure: true,
    ...overrides,
  });

  it('NOM：白名单类别放行（窗口内 + 故障前可信会话）', async () => {
    const controller = createController({
      access: {
        state: 'UNVERIFIABLE',
        degraded: true,
        degradedSince,
        remainingWindowMs: 300000,
        withinWindow: true,
        whitelistAllowed: true,
        reason: null,
      },
    });
    const result = await controller.checkAccess(actor(), input());

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.allowed, true);
    assert.equal(result.value.degraded, true);
  });

  it('NOM：受保护业务拒绝（窗口内也不放行）', async () => {
    const controller = createController({
      access: {
        state: 'UNVERIFIABLE',
        degraded: true,
        degradedSince,
        remainingWindowMs: 300000,
        withinWindow: true,
        whitelistAllowed: false,
        reason: '降级窗口内禁止受保护业务操作',
      },
    });
    const result = await controller.checkAccess(actor(), input({ category: 'PROTECTED_BUSINESS' }));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.allowed, false);
    assert.match(result.value.reason ?? '', /受保护业务/);
  });

  it('NOM：未可信会话 → 不授予白名单', async () => {
    const controller = createController({
      access: {
        state: 'UNVERIFIABLE',
        degraded: true,
        degradedSince,
        remainingWindowMs: 300000,
        withinWindow: true,
        whitelistAllowed: false,
        reason: '会话未在故障前可信登录，不授予白名单',
      },
    });
    const result = await controller.checkAccess(
      actor(),
      input({ sessionAuthenticatedBeforeFailure: false }),
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.allowed, false);
  });

  it('AUT：判定强制使用会话 subjectId 与传入类别，不经由客户端权限声明', async () => {
    fakeQueries.accessCalls = [];
    const controller = createController();
    await controller.checkAccess(
      actor({ subjectId: 'user-session' }),
      input({ category: 'PUBLIC_PAGE' }),
    );

    assert.equal(fakeQueries.accessCalls[0].subjectId, 'user-session');
    assert.equal(fakeQueries.accessCalls[0].category, 'PUBLIC_PAGE');
  });
});
