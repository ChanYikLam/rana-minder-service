/**
 * DefaultApplyProfileSyncStepUseCase 单元测试（IFC-SM-003；IDN-003/006/007/020、
 * CAS-WR-006/007、CAS-REC-001）。
 *
 * 覆盖：写后定向读回收口（目标/原值/第三值分流）、24 小时冻结转强制读回、
 * 更晚本地版本拒绝旧意图、结果不确定先读回。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultProfileSyncStateMachine } from '../../domain/state-machines/profile-sync.state-machine';
import { DefaultProfileSyncPolicy } from '../../domain/services/profile-sync.policy';
import { ProfileSyncState } from '../../domain/state-machines/profile-sync.state-machine';
import { ProfileWriteGateState } from '../../domain/state-machines/profile-write-gate.state-machine';
import type { ProfileSyncIntentSnapshot } from '../../domain/models/profile-sync-intent';
import { externalSuccess, externalFailure } from '../../../../common/contracts/external-result';
import type { CasdoorUserPort } from '../ports/casdoor-user.port';
import type { ProfileSyncIntentRepository } from '../ports/profile-sync-intent-repository.port';
import type { ProfileSyncTaskPort } from '../ports/profile-sync-task.port';
import type { IdentityAuditPort } from '../ports/identity-audit.port';
import type { ProfileRepository } from '../ports/profile-repository.port';
import {
  DefaultApplyProfileSyncStepUseCase,
  type ApplyProfileSyncStepInput,
} from './apply-profile-sync-step.use-case';
import { IdentityErrorCode } from '../errors';

const now = new Date('2026-08-20T12:00:00.000Z');

function pendingIntent(overrides?: Partial<ProfileSyncIntentSnapshot>): ProfileSyncIntentSnapshot {
  return {
    id: 'intent-1',
    subjectId: 'user-1',
    field: 'phone',
    targetVersion: 4,
    priorValue: '13700000000',
    targetValue: '13800000000',
    readbackValue: null,
    state: ProfileSyncState.PENDING_SYNC,
    conflictVersion: null,
    attempts: 0,
    retryAt: null,
    failedSince: null,
    resolvedAt: null,
    createdAt: new Date('2026-08-20T11:00:00Z'),
    ...overrides,
  };
}

function profileSnapshot(version = 4) {
  return {
    subjectId: 'user-1',
    fields: { phone: '13800000000' },
    emailVerified: true,
    verifiedEmail: 'old@example.com',
    pendingEmail: null,
    version,
    gateState: ProfileWriteGateState.WRITABLE,
    restrictions: [],
  };
}

function inMemoryIntentRepository(): ProfileSyncIntentRepository & { saved: any[] } {
  const store = new Map<string, ProfileSyncIntentSnapshot>();
  return {
    saved: [],
    async load(subjectId, field) {
      return store.get(`${subjectId}:${field}`) ?? null;
    },
    async loadMany(subjectId, fields) {
      return fields
        .map((field) => store.get(`${subjectId}:${field}`))
        .filter((snapshot) => snapshot !== undefined);
    },
    async save(snapshot) {
      store.set(`${snapshot.subjectId}:${snapshot.field}`, snapshot);
      this.saved.push(snapshot);
    },
  };
}

function createUseCase(overrides?: {
  intentRepository?: ProfileSyncIntentRepository;
  profileRepository?: ProfileRepository;
  casdoor?: CasdoorUserPort;
  taskPort?: ProfileSyncTaskPort;
  audit?: IdentityAuditPort;
}) {
  return new DefaultApplyProfileSyncStepUseCase(
    overrides?.intentRepository ?? inMemoryIntentRepository(),
    overrides?.profileRepository ?? {
      async load(_subjectId: string) {
        return profileSnapshot();
      },
      async save() {},
    },
    overrides?.casdoor ?? {
      async readAccountStatus() {
        return externalSuccess({ state: 'ACTIVE', observedAt: now, externalVersion: null }, 'a1');
      },
      async readProfileField() {
        return externalSuccess({ field: 'phone', value: '13800000000', externalVersion: null, observedAt: now }, 'a2');
      },
      async writeProfileField() {
        return externalSuccess({ field: 'phone', value: '13800000000', externalVersion: null, observedAt: now }, 'a3');
      },
    },
    overrides?.taskPort ?? {
      async scheduleProfileSync() {},
      async scheduleProfileReadback() {},
      async scheduleNameCorrectionWrite() {},
    },
    overrides?.audit ?? { async record() {} },
    new DefaultProfileSyncStateMachine(),
    new DefaultProfileSyncPolicy(),
  );
}

function inputFor(overrides?: Partial<ApplyProfileSyncStepInput>): ApplyProfileSyncStepInput {
  return {
    subjectId: 'user-1',
    field: 'phone',
    targetVersion: 4,
    intentId: 'intent-1',
    now,
    actor: 'sync-task',
    traceId: 'tr_sync_001',
    ...overrides,
  };
}

describe('ApplyProfileSyncStepUseCase（IFC-SM-003）', () => {
  it('NOM：R002/R003 写入并回读确认目标值 → 已同步（目标收口）', async () => {
    const intentRepository = inMemoryIntentRepository();
    intentRepository.save(pendingIntent(), []);
    const useCase = createUseCase({ intentRepository });

    const outcome = await useCase.execute(inputFor());

    assert.equal(outcome.kind, 'SYNCED');
    assert.equal(intentRepository.saved.at(-1).state, ProfileSyncState.SYNCED);
    assert.equal(intentRepository.saved.at(-1).resolvedAt !== null, true);
  });

  it('NOM：R007 回读确认仍为修改前有效值 → 已回退（先可信读回才回退）', async () => {
    const intentRepository = inMemoryIntentRepository();
    intentRepository.save(
      pendingIntent({ state: ProfileSyncState.PENDING_READBACK_VERIFICATION }),
      [],
    );
    intentRepository.saved.length = 0;
    const casdoor: CasdoorUserPort = {
      async readAccountStatus() {
        return externalSuccess({ state: 'ACTIVE', observedAt: now, externalVersion: null }, 'a1');
      },
      async readProfileField() {
        return externalSuccess({ field: 'phone', value: '13700000000', externalVersion: null, observedAt: now }, 'a2');
      },
      async writeProfileField() {
        return externalSuccess({ field: 'phone', value: '13800000000', externalVersion: null, observedAt: now }, 'a3');
      },
    };
    const useCase = createUseCase({ intentRepository, casdoor });

    const outcome = await useCase.execute(inputFor());

    assert.equal(outcome.kind, 'ROLLED_BACK');
    assert.equal(intentRepository.saved.at(-1).state, ProfileSyncState.ROLLED_BACK);
  });

  it('NOM：R008 普通可编辑字段读回第三值 → 同步冲突待本人选择', async () => {
    const intentRepository = inMemoryIntentRepository();
    intentRepository.save(
      pendingIntent({ state: ProfileSyncState.PENDING_READBACK_VERIFICATION }),
      [],
    );
    intentRepository.saved.length = 0;
    const casdoor: CasdoorUserPort = {
      async readAccountStatus() {
        return externalSuccess({ state: 'ACTIVE', observedAt: now, externalVersion: null }, 'a1');
      },
      async readProfileField() {
        return externalSuccess({ field: 'phone', value: '13911112222', externalVersion: null, observedAt: now }, 'a2');
      },
      async writeProfileField() {
        return externalSuccess({ field: 'phone', value: '13800000000', externalVersion: null, observedAt: now }, 'a3');
      },
    };
    const useCase = createUseCase({ intentRepository, casdoor });

    const outcome = await useCase.execute(inputFor());

    assert.equal(outcome.kind, 'CONFLICT');
    assert.equal(
      intentRepository.saved.at(-1).state,
      ProfileSyncState.CONFLICT_PENDING_USER_CHOICE,
    );
    assert.equal(intentRepository.saved.at(-1).conflictVersion, 4);
  });

  it('NOM：R004 写入成功但回读非目标值 → 写入未确认，按退避重试', async () => {
    const intentRepository = inMemoryIntentRepository();
    intentRepository.save(pendingIntent(), []);
    intentRepository.saved.length = 0;
    const casdoor: CasdoorUserPort = {
      async readAccountStatus() {
        return externalSuccess({ state: 'ACTIVE', observedAt: now, externalVersion: null }, 'a1');
      },
      async readProfileField() {
        return externalSuccess({ field: 'phone', value: '13700000000', externalVersion: null, observedAt: now }, 'a2');
      },
      async writeProfileField() {
        return externalSuccess({ field: 'phone', value: '13800000000', externalVersion: null, observedAt: now }, 'a3');
      },
    };
    const useCase = createUseCase({ intentRepository, casdoor });

    const outcome = await useCase.execute(inputFor());

    assert.equal(outcome.kind, 'RETRY_SCHEDULED');
    assert.equal(intentRepository.saved.at(-1).state, ProfileSyncState.RETRYING);
    assert.equal(intentRepository.saved.at(-1).attempts, 1);
  });

  it('IDN-007：更晚本地版本 → 旧同步意图不推进（仅审计跳过）', async () => {
    const intentRepository = inMemoryIntentRepository();
    intentRepository.save(pendingIntent(), []);
    const casdoor: CasdoorUserPort = {
      async readAccountStatus() {
        return externalSuccess({ state: 'ACTIVE', observedAt: now, externalVersion: null }, 'a1');
      },
      async readProfileField() {
        return externalSuccess({ field: 'phone', value: '13800000000', externalVersion: null, observedAt: now }, 'a2');
      },
      async writeProfileField() {
        return externalFailure(
          'RETRYABLE_FAILURE',
          { code: 'CAS_WRITE_TIMEOUT', message: '写入超时', retryable: true, rawStatusCode: null },
          'a3',
          now,
        );
      },
    };
    let rescheduled = 0;
    const taskPort: ProfileSyncTaskPort = {
      async scheduleProfileSync() {
        rescheduled += 1;
      },
      async scheduleProfileReadback() {},
      async scheduleNameCorrectionWrite() {},
    };
    const useCase = createUseCase({ intentRepository, casdoor, taskPort });

    const outcome = await useCase.execute(inputFor());

    assert.equal(outcome.kind, 'RETRY_SCHEDULED');
    assert.equal(intentRepository.saved.at(-1).state, ProfileSyncState.RETRYING);
    assert.equal(intentRepository.saved.at(-1).attempts, 1);
    assert.ok(intentRepository.saved.at(-1).retryAt > now);
    assert.equal(rescheduled, 1);
  });

  it('NOM：R005 连续 24 小时仍失败 → 冻结盲目写重试并登记强制读回', async () => {
    const intentRepository = inMemoryIntentRepository();
    intentRepository.save(
      pendingIntent({
        state: ProfileSyncState.RETRYING,
        attempts: 30,
        failedSince: new Date('2026-08-19T11:59:00Z'),
      }),
      [],
    );
    const casdoor: CasdoorUserPort = {
      async readAccountStatus() {
        return externalSuccess({ state: 'ACTIVE', observedAt: now, externalVersion: null }, 'a1');
      },
      async readProfileField() {
        return externalSuccess({ field: 'phone', value: '13800000000', externalVersion: null, observedAt: now }, 'a2');
      },
      async writeProfileField() {
        return externalFailure(
          'RETRYABLE_FAILURE',
          { code: 'CAS_WRITE_TIMEOUT', message: '写入超时', retryable: true, rawStatusCode: null },
          'a3',
          now,
        );
      },
    };
    let readbackScheduled = 0;
    const taskPort: ProfileSyncTaskPort = {
      async scheduleProfileSync() {},
      async scheduleProfileReadback() {
        readbackScheduled += 1;
      },
      async scheduleNameCorrectionWrite() {},
    };
    const useCase = createUseCase({ intentRepository, casdoor, taskPort });

    const outcome = await useCase.execute(inputFor());

    assert.equal(outcome.kind, 'READBACK_SCHEDULED');
    assert.equal(intentRepository.saved.at(-1).state, ProfileSyncState.PENDING_READBACK_VERIFICATION);
    assert.equal(readbackScheduled, 1);
  });

  it('VER：存在更晚本地版本 → 旧同步意图不推进（IDN-007），仅审计跳过', async () => {
    const intentRepository = inMemoryIntentRepository();
    intentRepository.save(pendingIntent(), []);
    intentRepository.saved.length = 0;
    let audited = 0;
    const useCase = createUseCase({
      intentRepository,
      profileRepository: {
        async load(_subjectId: string) {
          return profileSnapshot(5); // 本地版本已更新到 5
        },
async save(_snapshot, _events, _expectedVersion) {},
      },
      audit: {
        async record() {
          audited += 1;
        },
      },
    });

    const outcome = await useCase.execute(inputFor());

    assert.equal(outcome.kind, 'IDLE');
    assert.equal(intentRepository.saved.length, 0); // 不推进、不落库
    assert.equal(audited, 1);
  });

  it('UNK：外部写入结果不确定 → 不伪成功，登记失败并按规则重试', async () => {
    const intentRepository = inMemoryIntentRepository();
    intentRepository.save(pendingIntent(), []);
    const casdoor: CasdoorUserPort = {
      async readAccountStatus() {
        return externalSuccess({ state: 'ACTIVE', observedAt: now, externalVersion: null }, 'a1');
      },
      async readProfileField() {
        return externalSuccess({ field: 'phone', value: '13800000000', externalVersion: null, observedAt: now }, 'a2');
      },
      async writeProfileField() {
        return externalFailure(
          'UNCERTAIN',
          { code: 'CAS_UNKNOWN', message: '外部结果不确定', retryable: true, rawStatusCode: null },
          'a3',
          now,
        );
      },
    };
    const useCase = createUseCase({ intentRepository, casdoor });

    const outcome = await useCase.execute(inputFor());

    assert.equal(outcome.kind, 'RETRY_SCHEDULED');
    assert.notEqual(intentRepository.saved.at(-1).state, ProfileSyncState.SYNCED);
  });

  it('NOM：待读回核验状态直接执行回读 → 目标值 → 已同步（R006）', async () => {
    const intentRepository = inMemoryIntentRepository();
    intentRepository.save(
      pendingIntent({
        state: ProfileSyncState.PENDING_READBACK_VERIFICATION,
        failedSince: new Date('2026-08-19T11:59:00Z'),
      }),
      [],
    );
    const useCase = createUseCase({ intentRepository });

    const outcome = await useCase.execute(inputFor());

    assert.equal(outcome.kind, 'SYNCED');
    assert.equal(intentRepository.saved.at(-1).state, ProfileSyncState.SYNCED);
  });

  it('REV：同步意图不存在 → IFC-ERR-015', async () => {
    const useCase = createUseCase();

    await assert.rejects(
      () => useCase.execute(inputFor()),
      (err: any) => err.code === IdentityErrorCode.NOT_FOUND,
    );
  });
});