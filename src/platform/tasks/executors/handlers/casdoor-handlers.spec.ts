import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TaskExecutionError, TaskStatus, TaskType } from '../../contracts';
import type { TaskRecord } from '../../contracts';
import { TaskScopeKind } from '../../contracts';
import { CasdoorGroupHandler } from './casdoor-group.handler';
import { CasdoorSyncHandler } from './casdoor-sync.handler';
import { ReconciliationHandler } from './reconciliation.handler';
import { CasdoorWriteService } from '../../../casdoor/application/casdoor-write.service';
import { CasdoorReadService } from '../../../casdoor/application/casdoor-read.service';
import { CasdoorReconcileService } from '../../../casdoor/application/casdoor-reconcile.service';
import { InMemoryCasdoorStore } from '../../../casdoor/infrastructure/in-memory-casdoor-store';
import { InMemoryMappingStore } from '../../../casdoor/infrastructure/in-memory-mapping-store';
import { FreshnessRegistry } from '../../../casdoor/domain/freshness-registry';
import type { ClockPort } from '../../../casdoor/contracts/ports';
import type { CasdoorGroup } from '../../../casdoor/contracts/types';

const fixedNow = new Date('2026-08-20T00:00:00.000Z');
const clock: ClockPort = { now: () => fixedNow };

function makeTask(taskType: TaskType, payload: unknown): TaskRecord {
  return {
    taskId: `task:${taskType}:i-1`,
    taskType,
    status: TaskStatus.PENDING,
    intentId: 'i-1',
    idempotencyKey: 'idem-1',
    scope: { kind: TaskScopeKind.PLATFORM },
    source: {
      objectType: 'test',
      objectId: 'o1',
      version: 1,
      scope: { kind: TaskScopeKind.PLATFORM },
    },
    payload,
    lease: null,
    attempts: 0,
    maxAttempts: 5,
    notBefore: fixedNow.toISOString(),
    failure: null,
    resultRef: null,
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
  };
}

function assertTaskExecutionError(
  err: unknown,
  retryable: boolean,
  failureKind: string,
): boolean {
  assert.ok(err instanceof TaskExecutionError);
  assert.equal(err.retryable, retryable);
  assert.equal(err.failureKind, failureKind);
  return true;
}

const group: CasdoorGroup = {
  ref: { owner: 'o', name: 'g' },
  displayName: 'G',
  parentRef: null,
  memberIds: ['a'],
  state: 'ACTIVE',
};

const groupPayload = {
  commandId: 'cmd-1',
  idempotencyKey: 'idem-1',
  groupRef: group.ref,
  originalMemberIds: ['a'],
  targetMemberIds: ['a', 'b'],
  requestedAt: fixedNow.toISOString(),
};

describe('CasdoorGroupHandler', () => {
  it('payload 不完整 → 抛不可重试错误，不静默标记成功', async () => {
    const store = new InMemoryCasdoorStore({ groups: [group] });
    const handler = new CasdoorGroupHandler(new CasdoorWriteService(store, clock));
    await assert.rejects(
      handler.handle(makeTask(TaskType.CASDOOR_GROUP_WRITE, {})),
      (err: unknown) => assertTaskExecutionError(err, false, 'MANUAL_INTERVENTION_REQUIRED'),
    );
  });

  it('写结论依赖不可用（retryable）→ 抛可重试错误', async () => {
    const store = new InMemoryCasdoorStore({ groups: [group] });
    store.failNextWrite = 'UNAVAILABLE';
    const handler = new CasdoorGroupHandler(new CasdoorWriteService(store, clock));
    await assert.rejects(
      handler.handle(makeTask(TaskType.CASDOOR_GROUP_WRITE, groupPayload)),
      (err: unknown) => assertTaskExecutionError(err, true, 'EXTERNAL_FAILED'),
    );
  });

  it('写结论 CONFIRMED → 正常返回', async () => {
    const store = new InMemoryCasdoorStore({ groups: [group] });
    const handler = new CasdoorGroupHandler(new CasdoorWriteService(store, clock));
    await handler.handle(makeTask(TaskType.CASDOOR_GROUP_WRITE, groupPayload));
  });
});

describe('CasdoorSyncHandler', () => {
  function makeHandler(store: InMemoryCasdoorStore) {
    const read = new CasdoorReadService(store, new InMemoryMappingStore(), clock);
    return new CasdoorSyncHandler(read, new FreshnessRegistry());
  }

  it('payload 不完整 → 抛不可重试错误', async () => {
    const handler = makeHandler(new InMemoryCasdoorStore());
    await assert.rejects(
      handler.handle(makeTask(TaskType.CASDOOR_SYNC, {})),
      (err: unknown) => assertTaskExecutionError(err, false, 'MANUAL_INTERVENTION_REQUIRED'),
    );
  });

  it('账号不存在（NOT_FOUND）→ 抛不可重试错误，不静默标记成功', async () => {
    const handler = makeHandler(new InMemoryCasdoorStore());
    await assert.rejects(
      handler.handle(
        makeTask(TaskType.CASDOOR_SYNC, { externalUserId: 'cas-u1', trackingId: 'tr-1' }),
      ),
      (err: unknown) => assertTaskExecutionError(err, false, 'EXTERNAL_FAILED'),
    );
  });

  it('账号状态读取成功 → 正常返回', async () => {
    const store = new InMemoryCasdoorStore({
      users: [{ externalId: 'cas-u1', name: 'A', state: 'ACTIVE' }],
    });
    const handler = makeHandler(store);
    await handler.handle(
      makeTask(TaskType.CASDOOR_SYNC, { externalUserId: 'cas-u1', trackingId: 'tr-2' }),
    );
  });
});

describe('ReconciliationHandler', () => {
  function makeHandler(store: InMemoryCasdoorStore, mappings: InMemoryMappingStore) {
    const reconcile = new CasdoorReconcileService(store, mappings, clock);
    return new ReconciliationHandler(reconcile);
  }

  it('对账发现差异（PARTIAL_SUCCESS）→ 抛不可重试人工处置错误', async () => {
    const store = new InMemoryCasdoorStore({
      users: [{ externalId: 'u1', name: 'A', state: 'ACTIVE' }],
    });
    const handler = makeHandler(store, new InMemoryMappingStore());
    await assert.rejects(
      handler.handle(makeTask(TaskType.RECONCILIATION, {})),
      (err: unknown) => assertTaskExecutionError(err, false, 'MANUAL_INTERVENTION_REQUIRED'),
    );
  });

  it('扫描不确定（UNCERTAIN）→ 抛可重试错误', async () => {
    const store = new InMemoryCasdoorStore({
      users: [{ externalId: 'u1', name: 'A', state: 'ACTIVE' }],
    });
    const uncertainRead = Object.assign(Object.create(store), {
      enumerateAccounts: async () => ({
        status: 'UNCERTAIN' as const,
        value: null,
        evidence: { observedAt: fixedNow.toISOString() },
        error: {
          kind: 'UNCERTAIN' as const,
          code: 'CAS-ERR-UNCERTAIN',
          message: 'uncertain',
          retryable: true,
          trackingId: 't',
        },
      }),
    }) as typeof store;
    const handler = makeHandler(uncertainRead, new InMemoryMappingStore());
    await assert.rejects(
      handler.handle(makeTask(TaskType.RECONCILIATION, {})),
      (err: unknown) => assertTaskExecutionError(err, true, 'EXTERNAL_UNCERTAIN'),
    );
  });

  it('对账完整成功 → 正常返回', async () => {
    const store = new InMemoryCasdoorStore({
      users: [{ externalId: 'u1', name: 'A', state: 'ACTIVE' }],
      groups: [
        {
          ref: { owner: 'o', name: 'g' },
          displayName: 'G',
          parentRef: null,
          memberIds: ['u1'],
          state: 'ACTIVE',
        },
      ],
    });
    const mappings = new InMemoryMappingStore();
    await mappings.saveSubjectMapping({
      localSubjectId: 'u1',
      externalSubjectId: 'u1',
      instance: 'https://cas.example',
      status: 'BOUND',
      firstVerifiedAt: fixedNow.toISOString(),
      lastVerifiedAt: fixedNow.toISOString(),
      history: [],
    });
    await mappings.saveGroupMapping({
      localObjectRef: 'g',
      externalRef: { owner: 'o', name: 'g' },
      purpose: 'SCHOOL',
      status: 'BOUND',
      lastVerifiedAt: fixedNow.toISOString(),
      history: [],
    });
    await mappings.saveRelation({
      localSubjectId: 'u1',
      groupRef: { owner: 'o', name: 'g' },
      current: true,
      observedAt: fixedNow.toISOString(),
      source: 'LIVE_READ',
    });
    const handler = makeHandler(store, mappings);
    await handler.handle(makeTask(TaskType.RECONCILIATION, {}));
  });
});