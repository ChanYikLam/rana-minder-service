/**
 * ProfilesController 单元测试（接口层；接口清单 §4 API-AUTH-002）。
 *
 * 分面：
 * - NOM：GET/PUT profile、send-email-code、verify-email 的成功映射；
 * - 乐观锁：版本冲突 → 409 IFC-ERR-008 + currentData 供刷新；
 * - 校验：信封/字段级 422 IFC-ERR-005、非对象体 400 IFC-ERR-017；
 * - 邮箱验证例外：验证码错误/过期 → 422 IFC-ERR-007 + fieldErrors；
 * - AUT：subjectId 恒来自会话（ActorContext），请求信封的 targetId 不被采纳；
 *   越权（IFC-ERR-003）与作用域不符（IFC-ERR-004）按 HTTP 403 透传。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProfilesController, type ActorContext } from './profiles.controller';
import type { SaveProfileUseCase, SaveProfileResult } from '../../application/commands/save-profile.use-case';
import type { EmailVerificationUseCase } from '../../application/commands/email-verification.use-case';
import type { ResolveSyncConflictUseCase } from '../../application/commands/resolve-sync-conflict.use-case';
import type { GetMyProfileQuery, GetMyProfileResult } from '../../application/queries/get-my-profile.query';
import { IdentityCommandError, IdentityErrorCode } from '../../application/errors';

const now = new Date('2026-08-20T12:00:00.000Z');

function actor(overrides?: Partial<ActorContext>): ActorContext {
  return { subjectId: 'user-1', now, traceId: 'tr-1', mailCapable: true, ...overrides };
}

function myProfile(overrides?: Partial<GetMyProfileResult>): GetMyProfileResult {
  return {
    subjectId: 'user-1',
    version: 4,
    fields: { studentId: '20240001', name: '张三', phone: '13800000000', email: 'a@example.com' },
    emailVerified: true,
    verifiedEmail: 'a@example.com',
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

function saveResult(): SaveProfileResult {
  return {
    profile: {} as SaveProfileResult['profile'],
    changedFields: [],
    pendingSyncFields: [],
    syncIntentIds: [],
  };
}

interface FakeSave {
  lastInput: Parameters<SaveProfileUseCase['execute']>[0] | null;
  error: unknown;
  result: SaveProfileResult;
}
const fakeSave: FakeSave = {
  lastInput: null,
  error: null,
  result: saveResult(),
};

interface FakeEmail {
  sendInput: Parameters<EmailVerificationUseCase['sendVerificationEmail']>[0] | null;
  consumeInput: Parameters<EmailVerificationUseCase['consumeVerificationToken']>[0] | null;
  sendError: unknown;
  consumeError: unknown;
}

const fakeEmail: FakeEmail = {
  sendInput: null,
  consumeInput: null,
  sendError: null,
  consumeError: null,
};

interface FakeResolve {
  lastInput: Parameters<ResolveSyncConflictUseCase['execute']>[0] | null;
  error: unknown;
}

const fakeResolve: FakeResolve = {
  lastInput: null,
  error: null,
};

function createController(overrides?: {
  profile?: Partial<GetMyProfileResult>;
  queryError?: unknown;
}) {
  const fakeQuery: GetMyProfileQuery = {
    async execute(input) {
      const calls = (fakeQuery as { calls?: unknown[] }).calls ?? [];
      (fakeQuery as { calls?: unknown[] }).calls = calls;
      calls.push(input);
      if (overrides?.queryError !== undefined) {
        throw overrides.queryError;
      }
      return myProfile(overrides?.profile);
    },
  };
  const fakeSaveUseCase: SaveProfileUseCase = {
    async execute(input) {
      fakeSave.lastInput = input;
      if (fakeSave.error !== null) {
        throw fakeSave.error;
      }
      return fakeSave.result;
    },
  };
  const fakeEmailUseCase: EmailVerificationUseCase = {
    async sendVerificationEmail(input) {
      fakeEmail.sendInput = input;
      if (input.mailCapable === false) {
        throw new IdentityCommandError(IdentityErrorCode.PRECONDITION_FAILED, '平台发信能力不可用，无法发送验证邮件');
      }
      if (fakeEmail.sendError !== null) {
        throw fakeEmail.sendError;
      }
      return { verificationId: 'v-1', code: 'v-1:secret' };
    },
    async consumeVerificationToken(input) {
      fakeEmail.consumeInput = input;
      if (fakeEmail.consumeError !== null) {
        throw fakeEmail.consumeError;
      }
      return { verifiedEmail: 'a@example.com', syncIntentId: 'intent-1' };
    },
  };
  const fakeResolveUseCase: ResolveSyncConflictUseCase = {
    async execute(input) {
      fakeResolve.lastInput = input;
      if (fakeResolve.error !== null) {
        throw fakeResolve.error;
      }
      return { kind: 'KEPT_LOCAL', nextIntentId: 'intent-2' };
    },
  };
  const controller = new ProfilesController(fakeSaveUseCase, fakeEmailUseCase, fakeResolveUseCase, fakeQuery);
  return { controller, fakeQuery };
}

describe('ProfilesController.getMyProfile（GET /api/auth/profile）', () => {
  it('NOM：返回版本/字段/验证/完整度/同步状态', async () => {
    const { controller } = createController();
    const result = await controller.getMyProfile(actor());

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.version, 4);
    assert.equal(result.value.email, 'a@example.com');
    assert.equal(result.value.emailVerified, true);
    assert.equal(result.value.profileComplete, true);
  });

  it('AUT：查询强制使用会话 subjectId，不采纳请求方提供的其他身份', async () => {
    const { controller, fakeQuery } = createController();
    await controller.getMyProfile(actor({ subjectId: 'user-session' }));

    const calls = (fakeQuery as { calls?: { subjectId: string }[] }).calls ?? [];
    assert.equal(calls.length, 1);
    assert.equal(calls[0].subjectId, 'user-session');
  });

  it('AUT：越权错误按 403 透传（IFC-ERR-003）', async () => {
    const { controller } = createController({
      queryError: new IdentityCommandError(IdentityErrorCode.FORBIDDEN, '无权查看'),
    });
    const result = await controller.getMyProfile(actor());

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'IFC-ERR-003');
  });
});

describe('ProfilesController.saveMyProfile（PUT /api/auth/profile）', () => {
  it('NOM：信封+expectedVersion 保存并返回最新本人资料', async () => {
    fakeSave.error = null;
    const { controller } = createController();
    const result = await controller.saveMyProfile(
      actor(),
      { expectedVersion: 4, input: { phone: '13800000000' } },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.phone, '13800000000');
    assert.equal(fakeSave.lastInput?.expectedVersion, 4);
    assert.equal(fakeSave.lastInput?.fields.phone, '13800000000');
  });

  it('AUT：保存强制使用会话 subjectId，信封 targetId 不被采纳', async () => {
    fakeSave.error = null;
    const { controller } = createController();
    await controller.saveMyProfile(
      actor({ subjectId: 'user-session' }),
      { targetId: 'user-other', expectedVersion: 4, input: { phone: '13900000000' } },
    );

    assert.equal(fakeSave.lastInput?.subjectId, 'user-session');
  });

  it('乐观锁：版本冲突 → 409 IFC-ERR-008 + currentData 供刷新', async () => {
    fakeSave.error = new IdentityCommandError(IdentityErrorCode.VERSION_CONFLICT, '资料版本已变化');
    const { controller } = createController({
      profile: { version: 5, fields: { phone: '13700000000' } },
    });
    const result = await controller.saveMyProfile(
      actor(),
      { expectedVersion: 4, input: { phone: '13900000000' } },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'IFC-ERR-008');
    assert.ok('currentData' in result.body);
  });

  it('校验：缺少 expectedVersion → 422 IFC-ERR-005', async () => {
    const { controller } = createController();
    const result = await controller.saveMyProfile(actor(), { input: { phone: '1' } });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 422);
    assert.equal(result.body.code, 'IFC-ERR-005');
  });

  it('校验：不可编辑字段 → 422 IFC-ERR-005 + fieldErrors', async () => {
    const { controller } = createController();
    const result = await controller.saveMyProfile(
      actor(),
      { expectedVersion: 4, input: { studentId: '20240001' } },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 422);
    assert.ok(result.body.fieldErrors?.studentId);
  });

  it('校验：非对象请求体 → 400 IFC-ERR-017', async () => {
    const { controller } = createController();
    const result = await controller.saveMyProfile(actor(), null);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'IFC-ERR-017');
  });
});

describe('ProfilesController.sendEmailCode（POST send-email-code）', () => {
  it('NOM：返回 { sent:true, expiresIn:300 }', async () => {
    fakeEmail.sendError = null;
    const { controller } = createController();
    const result = await controller.sendEmailCode(actor(), { input: { email: 'new@example.com' } });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.sent, true);
    assert.equal(result.value.expiresIn, 300);
    assert.equal(fakeEmail.sendInput?.subjectId, 'user-1');
    assert.equal(fakeEmail.sendInput?.email, 'new@example.com');
  });

  it('发信能力缺失 → 按不可用映射（此处应用层前置条件 422）', async () => {
    fakeEmail.sendError = null;
    const { controller } = createController();
    const result = await controller.sendEmailCode(
      actor({ mailCapable: false }),
      { input: { email: 'new@example.com' } },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 422);
  });

  it('校验：缺少 email → 422 IFC-ERR-005 + fieldErrors.email', async () => {
    const { controller } = createController();
    const result = await controller.sendEmailCode(actor(), { input: {} });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 422);
    assert.ok(result.body.fieldErrors?.email);
  });
});

describe('ProfilesController.verifyEmail（POST verify-email）', () => {
  it('NOM：验证成功 → { emailVerified:true }，拆分 code 传参', async () => {
    fakeEmail.consumeError = null;
    const { controller } = createController();
    const result = await controller.verifyEmail(actor(), { input: { code: 'v-1:secret' } });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.emailVerified, true);
    assert.equal(fakeEmail.consumeInput?.verificationId, 'v-1');
    assert.equal(fakeEmail.consumeInput?.token, 'secret');
  });

  it('验证码错误/过期 → 422 IFC-ERR-007 + fieldErrors.code（清单 §4 例外）', async () => {
    fakeEmail.consumeError = new IdentityCommandError(
      IdentityErrorCode.PRECONDITION_FAILED,
      '验证令牌不正确',
    );
    const { controller } = createController();
    const result = await controller.verifyEmail(actor(), { input: { code: 'v-1:wrong' } });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 422);
    assert.equal(result.body.code, 'IFC-ERR-007');
    assert.deepEqual(result.body.fieldErrors?.code, ['验证令牌不正确']);
  });

  it('校验：缺少 code → 422 IFC-ERR-005 + fieldErrors.code', async () => {
    const { controller } = createController();
    const result = await controller.verifyEmail(actor(), { input: {} });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 422);
    assert.ok(result.body.fieldErrors?.code);
  });
});

describe('ProfilesController.resolveSyncConflict（POST sync-conflict）', () => {
  it('NOM：选择本地目标值 → 返回最新资料快照', async () => {
    fakeResolve.error = null;
    const { controller } = createController();
    const result = await controller.resolveSyncConflict(
      actor(),
      { input: { field: 'phone', chosenValue: '13800000000' } },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.phone, '13800000000');
    assert.equal(fakeResolve.lastInput?.field, 'phone');
    assert.equal(fakeResolve.lastInput?.chosenValue, '13800000000');
    assert.equal(fakeResolve.lastInput?.subjectId, 'user-1');
  });

  it('AUT：subjectId 恒来自会话', async () => {
    fakeResolve.error = null;
    const { controller } = createController();
    await controller.resolveSyncConflict(
      actor({ subjectId: 'user-session' }),
      { input: { field: 'phone', chosenValue: '13800000000' } },
    );

    assert.equal(fakeResolve.lastInput?.subjectId, 'user-session');
  });

  it('拒绝：只读权威字段（name/studentId）→ 422 IFC-ERR-006', async () => {
    const { controller } = createController();
    const result = await controller.resolveSyncConflict(
      actor(),
      { input: { field: 'name', chosenValue: '张三' } },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 422);
    assert.equal(result.body.code, 'IFC-ERR-006');
  });

  it('透传：无待选冲突 → 422 IFC-ERR-006', async () => {
    fakeResolve.error = new IdentityCommandError(
      IdentityErrorCode.PRECONDITION_FAILED,
      '该字段不存在待选择的同步冲突',
    );
    const { controller } = createController();
    const result = await controller.resolveSyncConflict(
      actor(),
      { input: { field: 'phone', chosenValue: '13800000000' } },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 422);
    assert.equal(result.body.code, 'IFC-ERR-006');
  });

  it('校验：缺少 chosenValue → 422 IFC-ERR-005 + fieldErrors.chosenValue', async () => {
    const { controller } = createController();
    const result = await controller.resolveSyncConflict(actor(), { input: { field: 'phone' } });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 422);
    assert.ok(result.body.fieldErrors?.chosenValue);
  });
});