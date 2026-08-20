/**
 * DefaultResolveSyncConflictUseCase 单元测试（IFC-SM-003 R009/R010；SRS-INV-015）。
 *
 * 覆盖：
 * - R009 保留本地值：新版本/新意图/重新待同步/登记任务；
 * - R010 接受 Casdoor 值：本地采用外部值（邮箱落已验证）、关闭冲突窗口；
 * - 前置守卫：提交前重新可信读回且与快照一致、冲突版本匹配；
 * - 拒绝：字段白名单（只读权威字段不经本人选择）、无待选冲突、选择值二选一；
 * - AUT：subjectId 恒来自命令输入，无跨主体路径。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultResolveSyncConflictUseCase } from './resolve-sync-conflict.use-case';
import { ProfileSyncState, DefaultProfileSyncStateMachine } from '../../domain/state-machines/profile-sync.state-machine';
import { DefaultProfileWriteGateStateMachine, ProfileWriteGateState } from '../../domain/state-machines/profile-write-gate.state-machine';
import { DefaultProfileGatePolicy } from '../../domain/services/profile-gate.policy';
import { EditableProfileField } from '../../domain/models/profile-field';
import type { ProfileSnapshot } from '../../domain/models/profile';
import type { ProfileSyncIntentSnapshot } from '../../domain/models/profile-sync-intent';
import type { ProfileRepository } from '../ports/profile-repository.port';
import type { ProfileSyncIntentRepository } from '../ports/profile-sync-intent-repository.port';
import type { CasdoorUserPort } from '../ports/casdoor-user.port';
import type { ProfileSyncTaskPort } from '../ports/profile-sync-task.port';
import type { IdentityAuditPort } from '../ports/identity-audit.port';
import { IdentityErrorCode } from '../errors';
import { externalSuccess, externalFailure } from '../../../../common/contracts/external-result';

const now = new Date('2026-08-20T12:00:00.000Z');

function profileSnapshot(overrides?: Partial<ProfileSnapshot>): ProfileSnapshot {
  return {
    subjectId: 'user-1',
    fields: { phone: '13800000000' },
    emailVerified: true,
    verifiedEmail: 'a@example.com',
    pendingEmail: null,
    version: 4,
    gateState: ProfileWriteGateState.WRITABLE,
    restrictions: [],
    ...overrides,
  };
}

function conflictIntent(overrides?: Partial<ProfileSyncIntentSnapshot>): ProfileSyncIntentSnapshot {
  return {
    id: 'intent-1',
    subjectId: 'user-1',
    field: EditableProfileField.PHONE,
    targetVersion: 4,
    priorValue: '13700000000',
    targetValue: '13800000000',
    readbackValue: '13911111111', // Casdoor 第三值
    state: ProfileSyncState.CONFLICT_PENDING_USER_CHOICE,
    conflictVersion: 4,
    attempts: 3,
    retryAt: null,
    failedSince: now,
    resolvedAt: null,
    createdAt: now,
    ...overrides,
  };
}

interface Fakes {
  profiles: Map<string, ProfileSnapshot>;
  intents: Map<string, ProfileSyncIntentSnapshot>;
  readback: { value: string | null } | null;
  saved: { profiles: ProfileSnapshot[]; intents: ProfileSyncIntentSnapshot[]; tasks: unknown[]; audits: unknown[] };
}

const fakes: Fakes = {
  profiles: new Map(),
  intents: new Map(),
  readback: { value: '13911111111' },
  saved: { profiles: [], intents: [], tasks: [], audits: [] },
};

function createUseCase() {
  fakes.profiles.set('user-1', profileSnapshot());
  fakes.intents.set('user-1:phone', conflictIntent());
  fakes.readback = { value: '13911111111' };
  fakes.saved = { profiles: [], intents: [], tasks: [], audits: [] };

  const profileRepository: ProfileRepository = {
    async load(subjectId) {
      return fakes.profiles.get(subjectId) ?? null;
    },
    async save(snapshot) {
      fakes.saved.profiles.push(snapshot);
      fakes.profiles.set(snapshot.subjectId, snapshot);
    },
  };
  const intentRepository: ProfileSyncIntentRepository = {
    async load(subjectId, field) {
      return fakes.intents.get(`${subjectId}:${field}`) ?? null;
    },
    async save(snapshot) {
      fakes.saved.intents.push(snapshot);
      fakes.intents.set(`${snapshot.subjectId}:${snapshot.field}`, snapshot);
    },
  };
  const casdoor: CasdoorUserPort = {
    async readAccountStatus() {
      throw new Error('not used');
    },
    async readProfileField() {
      if (fakes.readback === null) {
        return externalFailure('UNAVAILABLE', {
          code: 'CAS-READ-UNAVAILABLE',
          message: 'Casdoor 暂不可用',
          retryable: true,
          rawStatusCode: null,
        }, 'a-1', now);
      }
      return externalSuccess({
        field: 'phone',
        value: fakes.readback.value,
        externalVersion: 'v-9',
        observedAt: now,
      }, 'a-1', now);
    },
    async writeProfileField() {
      throw new Error('not used');
    },
  };
  const taskPort: ProfileSyncTaskPort = {
    async scheduleProfileSync(subjectId, field, targetVersion, intentId) {
      fakes.saved.tasks.push({ subjectId, field, targetVersion, intentId });
    },
    async scheduleProfileReadback() {},
    async scheduleNameCorrectionWrite() {},
  };
  const audit: IdentityAuditPort = {
    async record(fact) {
      fakes.saved.audits.push(fact);
    },
  };
  return new DefaultResolveSyncConflictUseCase(
    intentRepository,
    profileRepository,
    casdoor,
    taskPort,
    audit,
    new DefaultProfileSyncStateMachine(),
    new DefaultProfileWriteGateStateMachine(),
    new DefaultProfileGatePolicy(),
  );
}

function input(overrides?: Partial<Parameters<DefaultResolveSyncConflictUseCase['execute']>[0]>) {
  return {
    subjectId: 'user-1',
    field: EditableProfileField.PHONE as 'phone',
    chosenValue: '13800000000',
    now,
    actor: 'user-1',
    traceId: 'tr-1',
    ...overrides,
  };
}

describe('ResolveSyncConflictUseCase（IFC-SM-003 R009/R010）', () => {
  it('R009：选择本地目标值 → 新版本/新意图/重新待同步/登记任务', async () => {
    const useCase = createUseCase();

    const result = await useCase.execute(input({ chosenValue: '13800000000' }));

    assert.equal(result.kind, 'KEPT_LOCAL');
    if (result.kind !== 'KEPT_LOCAL') return;
    assert.ok(result.nextIntentId.length > 0);
    const savedProfile = fakes.saved.profiles[0];
    const savedIntent = fakes.saved.intents[fakes.saved.intents.length - 1];
    assert.equal(savedProfile.version, 5);
    assert.equal(savedIntent.field, 'phone');
    assert.equal(savedIntent.state, ProfileSyncState.PENDING_SYNC);
    assert.equal(savedIntent.targetVersion, 5);
    assert.equal(savedIntent.targetValue, '13800000000');
    assert.equal(savedIntent.priorValue, '13911111111');
    assert.equal(fakes.saved.tasks.length, 1);
    assert.deepEqual(fakes.saved.tasks[0], {
      subjectId: 'user-1',
      field: 'phone',
      targetVersion: 5,
      intentId: result.nextIntentId,
    });
    const audit = fakes.saved.audits[0] as { summary: Record<string, unknown> };
    assert.equal(audit.summary.outcome, 'USER_KEPT_LOCAL');
  });

  it('R010：选择 Casdoor 当前值 → 本地采用外部值并关闭冲突窗口', async () => {
    const useCase = createUseCase();

    const result = await useCase.execute(input({ chosenValue: '13911111111' }));

    assert.equal(result.kind, 'ACCEPTED_CASDOOR');
    const savedProfile = fakes.saved.profiles[0];
    assert.equal(savedProfile.fields.phone, '13911111111');
    assert.equal(savedProfile.version, 5);
    assert.equal(fakes.saved.intents[0].state, ProfileSyncState.SYNCED);
    assert.ok(fakes.saved.intents[0].resolvedAt !== null);
    assert.equal(fakes.saved.tasks.length, 0); // 不新起同步
    const audit = fakes.saved.audits[0] as { summary: Record<string, unknown> };
    assert.equal(audit.summary.outcome, 'USER_ACCEPTED_CASDOOR');
  });

  it('R010：接受 Casdoor 邮箱值 → emailVerified 落位并重算资料门', async () => {
    const useCase = createUseCase();
    fakes.intents.set('user-1:email', conflictIntent({
      field: EditableProfileField.EMAIL,
      targetValue: 'new@example.com',
      readbackValue: 'casdoor@example.com',
      conflictVersion: 4,
    }));
    fakes.readback = { value: 'casdoor@example.com' };

    const result = await useCase.execute(input({ field: 'email', chosenValue: 'casdoor@example.com' }));

    assert.equal(result.kind, 'ACCEPTED_CASDOOR');
    const savedProfile = fakes.saved.profiles[0];
    assert.equal(savedProfile.fields.email, 'casdoor@example.com');
    assert.equal(savedProfile.verifiedEmail, 'casdoor@example.com');
    assert.equal(savedProfile.emailVerified, true);
  });

  it('守卫：提交前重新读回与快照不一致 → 拒绝', async () => {
    const useCase = createUseCase();
    fakes.readback = { value: '19999999999' }; // 与冲突快照第三值不同

    await assert.rejects(
      useCase.execute(input({ chosenValue: '13800000000' })),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('已变化') &&
        'code' in error &&
        (error as { code: string }).code === IdentityErrorCode.PRECONDITION_FAILED,
    );
    assert.equal(fakes.saved.profiles.length, 0);
    assert.equal(fakes.saved.intents.length, 0);
  });

  it('守卫：Casdoor 不可确认 → 拒绝且无副作用', async () => {
    const useCase = createUseCase();
    fakes.readback = null;

    await assert.rejects(useCase.execute(input({ chosenValue: '13800000000' })));
    assert.equal(fakes.saved.profiles.length, 0);
  });

  it('守卫：存在更晚本地版本（冲突版本不匹配）→ 拒绝', async () => {
    const useCase = createUseCase();
    fakes.profiles.set('user-1', profileSnapshot({ version: 5 }));

    await assert.rejects(
      useCase.execute(input({ chosenValue: '13800000000' })),
      (error: unknown) => error instanceof Error && error.message.includes('版本已变化'),
    );
  });

  it('拒绝：字段不在白名单（只读权威字段不经本人选择）→ 422 IFC-ERR-006', async () => {
    const useCase = createUseCase();

    await assert.rejects(
      useCase.execute(input({ field: 'name' as 'phone', chosenValue: '张三' })),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('白名单') &&
        'code' in error &&
        (error as { code: string }).code === IdentityErrorCode.PRECONDITION_FAILED,
    );
  });

  it('拒绝：无待选择冲突（无意图/不在冲突状态）', async () => {
    const useCase = createUseCase();
    fakes.intents.clear();
    await assert.rejects(useCase.execute(input({ chosenValue: '13800000000' })));

    const useCase2 = createUseCase();
    fakes.intents.set('user-1:phone', conflictIntent({ state: ProfileSyncState.SYNCED }));
    await assert.rejects(useCase2.execute(input({ chosenValue: '13800000000' })));
  });

  it('拒绝：选择值必须二选一', async () => {
    const useCase = createUseCase();

    await assert.rejects(
      useCase.execute(input({ chosenValue: '15555555555' })),
      (error: unknown) => error instanceof Error && error.message.includes('之一'),
    );
    assert.equal(fakes.saved.profiles.length, 0);
  });

  it('AUT：subjectId 恒来自命令输入，无跨主体路径', async () => {
    const useCase = createUseCase();
    fakes.profiles.set('user-other', profileSnapshot({ subjectId: 'user-other' }));

    await assert.rejects(useCase.execute(input({ subjectId: 'user-other' })));
    // 不存在的冲突意图 → 拒绝，不读取他人资料字段
    assert.equal(fakes.saved.profiles.length, 0);
  });
});