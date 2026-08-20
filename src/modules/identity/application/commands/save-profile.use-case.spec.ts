/**
 * DefaultSaveProfileUseCase 单元测试（IFC-SM-002 R001/R002；IDN-002/006/010/011/019）。
 *
 * 覆盖：乐观锁版本冲突、白名单字段过滤、邮箱进入待验证、同步意图创建与任务登记、
 * 必填字段生效收紧资料门、审计同事务落点。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultProfileWriteGateStateMachine } from '../../domain/state-machines/profile-write-gate.state-machine';
import { DefaultProfileGatePolicy } from '../../domain/services/profile-gate.policy';
import { ProfileWriteGateState } from '../../domain/state-machines/profile-write-gate.state-machine';
import type {
  ProfileRepository,
} from '../ports/profile-repository.port';
import type {
  ProfileSyncIntentRepository,
} from '../ports/profile-sync-intent-repository.port';
import type { RequiredFieldRulesPort } from '../ports/required-field-rules.port';
import type { ProfileSyncTaskPort } from '../ports/profile-sync-task.port';
import type { IdentityAuditPort } from '../ports/identity-audit.port';
import {
  DefaultSaveProfileUseCase,
  type SaveProfileInput,
} from './save-profile.use-case';
import { IdentityErrorCode } from '../errors';
import type { ProfileSnapshot } from '../../domain/models/profile';

const now = new Date('2026-08-20T12:00:00.000Z');

function baseProfileSnapshot(overrides?: Partial<ProfileSnapshot>): ProfileSnapshot {
  return {
    subjectId: 'user-1',
    fields: { phone: '13700000000' },
    emailVerified: true,
    verifiedEmail: 'old@example.com',
    pendingEmail: null,
    version: 3,
    gateState: ProfileWriteGateState.WRITABLE,
    restrictions: [],
    ...overrides,
  };
}

function inMemoryProfileRepository(): ProfileRepository & {
  saved: ProfileSnapshot[];
  seed: (snapshot: ProfileSnapshot) => void;
} {
  const store = new Map<string, ProfileSnapshot>();
  return {
    saved: [],
    seed(snapshot) {
      store.set(snapshot.subjectId, snapshot);
    },
    async load(subjectId) {
      return store.get(subjectId) ?? null;
    },
    async save(snapshot) {
      store.set(snapshot.subjectId, snapshot);
      this.saved.push(snapshot);
    },
  };
}

function inMemorySyncIntentRepository(): ProfileSyncIntentRepository & {
  saved: any[];
  seed: (snapshot: any) => void;
} {
  const store = new Map<string, any>();
  return {
    saved: [],
    seed(snapshot) {
      store.set(`${snapshot.subjectId}:${snapshot.field}`, snapshot);
    },
    async load(subjectId, field) {
      return store.get(`${subjectId}:${field}`) ?? null;
    },
    async save(snapshot) {
      store.set(`${snapshot.subjectId}:${snapshot.field}`, snapshot);
      this.saved.push(snapshot);
    },
  };
}

function noopTaskPort(): ProfileSyncTaskPort {
  return {
    async scheduleProfileSync() {},
    async scheduleProfileReadback() {},
    async scheduleNameCorrectionWrite() {},
  };
}

function noopAuditPort(): IdentityAuditPort {
  return {
    async record() {},
  };
}

function noRequiredFields(): RequiredFieldRulesPort {
  return {
    async getPlatformRequiredFields() {
      return [];
    },
  };
}

function createUseCase(overrides?: {
  repository?: ProfileRepository;
  intentRepository?: ProfileSyncIntentRepository;
  requiredFields?: RequiredFieldRulesPort;
  taskPort?: ProfileSyncTaskPort;
  audit?: IdentityAuditPort;
}) {
  return new DefaultSaveProfileUseCase(
    overrides?.repository ?? inMemoryProfileRepository(),
    overrides?.intentRepository ?? inMemorySyncIntentRepository(),
    overrides?.requiredFields ?? noRequiredFields(),
    overrides?.taskPort ?? noopTaskPort(),
    overrides?.audit ?? noopAuditPort(),
    new DefaultProfileWriteGateStateMachine(),
    new DefaultProfileGatePolicy(),
  );
}

function inputFor(overrides?: Partial<SaveProfileInput>): SaveProfileInput {
  return {
    subjectId: 'user-1',
    expectedVersion: 3,
    fields: { phone: '13800000000', college: '计算机学院' },
    now,
    actor: 'user-1',
    traceId: 'tr_test_001',
    ...overrides,
  };
}

describe('SaveProfileUseCase（IFC-SM-002 R001）', () => {
  it('NOM：保存白名单字段 → 版本 +1、同步意图创建、任务登记、审计落库', async () => {
    const repository = inMemoryProfileRepository();
    repository.seed(baseProfileSnapshot());
    const intentRepository = inMemorySyncIntentRepository();
    let scheduled = 0;
    const taskPort: ProfileSyncTaskPort = {
      async scheduleProfileSync() {
        scheduled += 1;
      },
      async scheduleProfileReadback() {},
      async scheduleNameCorrectionWrite() {},
    };
    let audited = 0;
    const audit: IdentityAuditPort = {
      async record() {
        audited += 1;
      },
    };

    const useCase = createUseCase({ repository, intentRepository, taskPort, audit });
    const result = await useCase.execute(inputFor());

    assert.equal(result.profile.version, 4);
    assert.deepEqual([...result.changedFields].sort(), ['college', 'phone']);
    assert.deepEqual([...result.pendingSyncFields].sort(), ['college', 'phone']);
    assert.equal(intentRepository.saved.length, 2);
    assert.equal(scheduled, 2);
    assert.equal(audited, 1);
    assert.equal(repository.saved.length, 1);
    assert.equal(repository.saved[0].fields.phone, '13800000000');
  });

  it('NOM：邮箱修改 → 进入待验证，不创建邮箱同步意图（IDN-011）', async () => {
    const repository = inMemoryProfileRepository();
    repository.seed(
      baseProfileSnapshot({
        gateState: ProfileWriteGateState.PENDING_EMAIL_VERIFICATION,
        emailVerified: false,
        verifiedEmail: null,
      }),
    );
    const intentRepository = inMemorySyncIntentRepository();
    const useCase = createUseCase({ repository, intentRepository });

    const result = await useCase.execute(
      inputFor({ fields: { email: 'new@example.com' } }),
    );

    assert.equal(result.profile.pendingEmail, 'new@example.com');
    assert.equal(result.profile.verifiedEmail, null);
    assert.equal(result.pendingSyncFields.length, 0);
    assert.equal(intentRepository.saved.length, 0);
  });

  it('VER：乐观锁版本不匹配 → 409 IFC-ERR-008（不自动重放）', async () => {
    const repository = inMemoryProfileRepository();
    repository.seed(baseProfileSnapshot());
    const useCase = createUseCase({ repository });

    await assert.rejects(
      () => useCase.execute(inputFor({ expectedVersion: 2 })),
      (err: any) => err.code === IdentityErrorCode.VERSION_CONFLICT,
    );
  });

  it('REV：只读权威字段/未知字段 → 422 业务前置拒绝，无副作用', async () => {
    const repository = inMemoryProfileRepository();
    repository.seed(baseProfileSnapshot());
    const intentRepository = inMemorySyncIntentRepository();
    const useCase = createUseCase({ repository, intentRepository });

    await assert.rejects(
      () => useCase.execute(inputFor({ fields: { name: 'hacker' } as any })),
      (err: any) => err.code === IdentityErrorCode.PRECONDITION_FAILED,
    );
    assert.equal(intentRepository.saved.length, 0);
  });

  it('IDN-019：新必填字段已生效且缺失 → 资料门收紧为待补充', async () => {
    const repository = inMemoryProfileRepository();
    repository.seed(baseProfileSnapshot());
    const requiredFields: RequiredFieldRulesPort = {
      async getPlatformRequiredFields() {
        return [{ field: 'grade', effectiveAt: new Date('2026-08-01T00:00:00Z'), ruleVersion: 1 }];
      },
    };
    const useCase = createUseCase({ repository, requiredFields });

    const result = await useCase.execute(inputFor({ fields: { phone: '13800000000' } }));

    assert.equal(result.profile.gateState, ProfileWriteGateState.PENDING_COMPLETION);
    const gateEvent = result.profile.events.find((e) => e.type === 'GATE_TRANSITIONED');
    assert.ok(gateEvent);
  });

  it('IDN-010：必填字段未生效 → 不收紧资料门', async () => {
    const repository = inMemoryProfileRepository();
    repository.seed(baseProfileSnapshot());
    const requiredFields: RequiredFieldRulesPort = {
      async getPlatformRequiredFields() {
        return [{ field: 'grade', effectiveAt: new Date('2026-09-01T00:00:00Z'), ruleVersion: 1 }];
      },
    };
    const useCase = createUseCase({ repository, requiredFields });

    const result = await useCase.execute(inputFor({ fields: { phone: '13800000000' } }));

    assert.equal(result.profile.gateState, ProfileWriteGateState.WRITABLE);
  });

  it('REV：资料不存在 → IFC-ERR-015，不创建任何事实', async () => {
    const repository = inMemoryProfileRepository();
    const intentRepository = inMemorySyncIntentRepository();
    const useCase = createUseCase({ repository, intentRepository });

    await assert.rejects(
      () => useCase.execute(inputFor()),
      (err: any) => err.code === IdentityErrorCode.NOT_FOUND,
    );
    assert.equal(intentRepository.saved.length, 0);
  });
});

describe('SaveProfileUseCase（IFC-SM-002 R002 补齐必填）', () => {
  it('NOM：补齐最后一项必填 → 资料门由待补充进入待邮箱验证/可写（派生结果落位）', async () => {
    const repository = inMemoryProfileRepository();
    repository.seed(
      baseProfileSnapshot({
        fields: { phone: '13700000000', college: '计算机学院' },
        gateState: ProfileWriteGateState.PENDING_COMPLETION,
      }),
    );
    const requiredFields: RequiredFieldRulesPort = {
      async getPlatformRequiredFields() {
        return [{ field: 'grade', effectiveAt: new Date('2026-08-01T00:00:00Z'), ruleVersion: 1 }];
      },
    };
    const useCase = createUseCase({ repository, requiredFields });

    const result = await useCase.execute(
      inputFor({ fields: { grade: '2025 级' }, expectedVersion: 3 }),
    );

    assert.equal(result.profile.gateState, ProfileWriteGateState.WRITABLE);
  });
});