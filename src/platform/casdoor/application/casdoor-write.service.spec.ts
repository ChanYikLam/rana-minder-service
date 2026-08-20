import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CasdoorWriteService } from './casdoor-write.service';
import type { ClockPort, CasdoorWritePort } from '../contracts/ports';
import type { ExternalResult } from '../contracts/external-result';
import type { CasdoorGroup, CasdoorUser, GroupStableRef } from '../contracts/types';
import { groupRefKey } from '../contracts/types';
import { InMemoryCasdoorStore } from '../infrastructure/in-memory-casdoor-store';

const fixedNow = new Date('2026-08-20T00:00:00.000Z');
const clock: ClockPort = { now: () => fixedNow };

const group: CasdoorGroup = {
  ref: { owner: 'o', name: 'g' },
  displayName: 'G',
  parentRef: null,
  memberIds: ['a'],
  state: 'ACTIVE',
};

function makeStore() {
  return new InMemoryCasdoorStore({ groups: [group] });
}

function makeService(store: InMemoryCasdoorStore) {
  return new CasdoorWriteService(store, clock);
}

class RecordingWritePort implements CasdoorWritePort {
  readonly calls: string[] = [];

  constructor(private readonly inner: CasdoorWritePort) {}

  private record(kind: string, requestId: string): void {
    this.calls.push(`${kind}:${requestId}`);
  }

  async addGroupMembers(request: {
    ref: GroupStableRef;
    userIds: readonly string[];
    requestId: string;
    trackingId: string;
  }): Promise<ExternalResult<void>> {
    this.record('add', request.requestId);
    return this.inner.addGroupMembers(request);
  }

  async removeGroupMembers(request: {
    ref: GroupStableRef;
    userIds: readonly string[];
    requestId: string;
    trackingId: string;
  }): Promise<ExternalResult<void>> {
    this.record('remove', request.requestId);
    return this.inner.removeGroupMembers(request);
  }

  async updateUser(request: {
    externalUserId: string;
    patch: Readonly<Record<string, unknown>>;
    requestId: string;
    trackingId: string;
  }): Promise<ExternalResult<void>> {
    return this.inner.updateUser(request);
  }

  async readbackGroupMembers(request: {
    ref: GroupStableRef;
    requestId: string;
    trackingId: string;
  }): Promise<ExternalResult<readonly string[]>> {
    return this.inner.readbackGroupMembers(request);
  }

  async readbackUser(request: {
    externalUserId: string;
    requestId: string;
    trackingId: string;
  }): Promise<ExternalResult<CasdoorUser>> {
    return this.inner.readbackUser(request);
  }
}

describe('CasdoorWriteService', () => {
  it('写后定向读回确认目标关系才收口成功', async () => {
    const store = makeStore();
    const service = makeService(store);
    const conclusion = await service.writeGroupMembership({
      commandId: 'cmd-1',
      idempotencyKey: 'idem-1',
      groupRef: group.ref,
      originalMemberIds: ['a'],
      targetMemberIds: ['a', 'b'],
      requestedAt: fixedNow.toISOString(),
    });
    assert.equal(conclusion.kind, 'CONFIRMED');
    const readback = await store.readbackGroupMembers({
      ref: group.ref,
      requestId: 'check',
      trackingId: 't',
    });
    assert.deepEqual(readback.value, ['a', 'b']);
  });

  it('依赖不可用返回 DEPENDENCY_UNAVAILABLE 且不假成功', async () => {
    const store = makeStore();
    store.failNextWrite = 'UNAVAILABLE';
    const service = makeService(store);
    const conclusion = await service.writeGroupMembership({
      commandId: 'cmd-2',
      idempotencyKey: 'idem-2',
      groupRef: group.ref,
      originalMemberIds: ['a'],
      targetMemberIds: ['a', 'b'],
      requestedAt: fixedNow.toISOString(),
    });
    assert.equal(conclusion.kind, 'DEPENDENCY_UNAVAILABLE');
  });

  it('非法 deadline 回退到默认 15 分钟窗口，不因 Invalid Date 使超时守卫失效（CAS-WR-011）', async () => {
    const store = makeStore();
    const service = makeService(store);
    // 传入无法解析的 deadline，仍应正常执行并收口成功
    const conclusion = await service.writeGroupMembership({
      commandId: 'cmd-invalid-deadline',
      idempotencyKey: 'idem-invalid',
      groupRef: group.ref,
      originalMemberIds: ['a'],
      targetMemberIds: ['a', 'b'],
      requestedAt: fixedNow.toISOString(),
      deadline: 'not-a-valid-date',
    });
    assert.equal(conclusion.kind, 'CONFIRMED');
    const readback = await store.readbackGroupMembers({
      ref: group.ref,
      requestId: 'check',
      trackingId: 't',
    });
    assert.deepEqual(readback.value, ['a', 'b']);
  });

  it('同时增删时 add 与 remove 都执行并达成目标关系（不互斥）', async () => {
    const store = makeStore();
    const recording = new RecordingWritePort(store);
    const service = new CasdoorWriteService(recording, clock);
    const conclusion = await service.writeGroupMembership({
      commandId: 'cmd-mixed',
      idempotencyKey: 'idem-mixed',
      groupRef: group.ref,
      originalMemberIds: ['a', 'x'],
      targetMemberIds: ['a', 'b'],
      requestedAt: fixedNow.toISOString(),
    });
    assert.equal(conclusion.kind, 'CONFIRMED');
    assert.ok(recording.calls.some((c) => c.startsWith('add:')));
    assert.ok(recording.calls.some((c) => c.startsWith('remove:')));
    const readback = await store.readbackGroupMembers({
      ref: group.ref,
      requestId: 'check',
      trackingId: 't',
    });
    assert.deepEqual([...(readback.value ?? [])].sort(), ['a', 'b']);
  });

  it('复合新增按低权限到高权限执行；部分失败补偿已新增关系', async () => {
    const store = makeStore();

    const addLow: GroupStableRef = { owner: 'o', name: 'low' };
    const addHigh: GroupStableRef = { owner: 'o', name: 'high' };
    store.groups.set(groupRefKey(addLow), {
      ref: addLow,
      displayName: 'low',
      parentRef: null,
      memberIds: [],
      state: 'ACTIVE',
    });
    store.groups.set(groupRefKey(addHigh), {
      ref: addHigh,
      displayName: 'high',
      parentRef: null,
      memberIds: [],
      state: 'ACTIVE',
    });

    // 让第二个 step 的写入不确定；使用包装端口在 requestId 含 high 时返回不确定。
    const failing = new (class extends RecordingWritePort {
      override async addGroupMembers(request: {
        ref: GroupStableRef;
        userIds: readonly string[];
        requestId: string;
        trackingId: string;
      }): Promise<ExternalResult<void>> {
        if (request.requestId.includes('high')) {
          return {
            status: 'UNCERTAIN',
            value: null,
            evidence: { observedAt: fixedNow.toISOString(), attemptId: request.requestId },
            error: {
              kind: 'UNCERTAIN',
              code: 'CAS-ERR-UNCERTAIN',
              message: 'uncertain',
              retryable: true,
              trackingId: request.trackingId,
            },
          };
        }
        return super.addGroupMembers(request);
      }
    })(store);
    const service = new CasdoorWriteService(failing, clock);

    const conclusion = await service.executeCompositePlan(
      {
        planId: 'plan-1',
        commandId: 'cmd-comp',
        steps: [
          {
            stepId: 'low',
            groupRef: addLow,
            action: 'ADD',
            privilegeRank: 1,
            originalMemberIds: [],
            expectedMemberIds: ['u1'],
          },
          {
            stepId: 'high',
            groupRef: addHigh,
            action: 'ADD',
            privilegeRank: 2,
            originalMemberIds: [],
            expectedMemberIds: ['u1'],
          },
        ],
        deadline: new Date(fixedNow.getTime() + 15 * 60 * 1000).toISOString(),
      },
      { commandId: 'cmd-comp', idempotencyKey: 'idem-comp' },
    );

    assert.equal(conclusion.kind, 'MANUAL_INTERVENTION_REQUIRED');
    // 补偿时至少对 low 发出 remove（不授予部分新权限）
    assert.ok(failing.calls.some((c) => c.startsWith('remove:')));
  });

  it('补偿移除未确认时如实说明可能残留关系，不声称已完全回滚', async () => {
    const store = makeStore();

    const addLow: GroupStableRef = { owner: 'o', name: 'low' };
    store.groups.set(groupRefKey(addLow), {
      ref: addLow,
      displayName: 'low',
      parentRef: null,
      memberIds: [],
      state: 'ACTIVE',
    });

    const uncertain = (requestId: string): ExternalResult<void> => ({
      status: 'UNCERTAIN',
      value: null,
      evidence: { observedAt: fixedNow.toISOString(), attemptId: requestId },
      error: {
        kind: 'UNCERTAIN',
        code: 'CAS-ERR-UNCERTAIN',
        message: 'uncertain',
        retryable: true,
        trackingId: 't',
      },
    });

    // 步骤写入不确定触发补偿，且补偿移除本身也不确定
    const failing = new (class extends RecordingWritePort {
      override async addGroupMembers(request: {
        ref: GroupStableRef;
        userIds: readonly string[];
        requestId: string;
        trackingId: string;
      }): Promise<ExternalResult<void>> {
        if (request.requestId.includes('low')) return uncertain(request.requestId);
        return super.addGroupMembers(request);
      }

      override async removeGroupMembers(request: {
        ref: GroupStableRef;
        userIds: readonly string[];
        requestId: string;
        trackingId: string;
      }): Promise<ExternalResult<void>> {
        if (request.requestId.includes('comp')) return uncertain(request.requestId);
        return super.removeGroupMembers(request);
      }
    })(store);
    const service = new CasdoorWriteService(failing, clock);

    const conclusion = await service.executeCompositePlan(
      {
        planId: 'plan-3',
        commandId: 'cmd-comp3',
        steps: [
          {
            stepId: 'low',
            groupRef: addLow,
            action: 'ADD',
            privilegeRank: 1,
            originalMemberIds: [],
            expectedMemberIds: ['u1'],
          },
        ],
        deadline: new Date(fixedNow.getTime() + 15 * 60 * 1000).toISOString(),
      },
      { commandId: 'cmd-comp3', idempotencyKey: 'idem-comp3' },
    );

    assert.equal(conclusion.kind, 'MANUAL_INTERVENTION_REQUIRED');
    assert.match(conclusion.reason, /补偿移除未完全确认/);
  });

  it('复合写入当前失败 ADD step 的部分写入也会被回滚（CAS-WR-010）', async () => {
    const store = makeStore();

    const addLow: GroupStableRef = { owner: 'o', name: 'low' };
    const addHigh: GroupStableRef = { owner: 'o', name: 'high' };
    store.groups.set(groupRefKey(addLow), {
      ref: addLow,
      displayName: 'low',
      parentRef: null,
      memberIds: [],
      state: 'ACTIVE',
    });
    store.groups.set(groupRefKey(addHigh), {
      ref: addHigh,
      displayName: 'high',
      parentRef: null,
      memberIds: [],
      state: 'ACTIVE',
    });

    // 让 high 的读回只反映部分成员，从而当前失败 step 触发 PARTIAL_SUCCESS（部分写入）。
    const partial = new (class extends RecordingWritePort {
      override async readbackGroupMembers(request: {
        ref: GroupStableRef;
        requestId: string;
        trackingId: string;
      }): Promise<ExternalResult<readonly string[]>> {
        if (request.requestId.includes('high')) {
          return {
            status: 'TRUSTED_CURRENT',
            value: ['u1'], // 仅部分目标成员被写回，模拟部分成功
            evidence: { observedAt: fixedNow.toISOString(), attemptId: request.requestId },
            error: null,
          };
        }
        return super.readbackGroupMembers(request);
      }
    })(store);
    const service = new CasdoorWriteService(partial, clock);

    const conclusion = await service.executeCompositePlan(
      {
        planId: 'plan-2',
        commandId: 'cmd-comp2',
        steps: [
          {
            stepId: 'low',
            groupRef: addLow,
            action: 'ADD',
            privilegeRank: 1,
            originalMemberIds: [],
            expectedMemberIds: ['u1', 'u2'],
          },
          {
            stepId: 'high',
            groupRef: addHigh,
            action: 'ADD',
            privilegeRank: 2,
            originalMemberIds: [],
            expectedMemberIds: ['u1', 'u2'],
          },
        ],
        deadline: new Date(fixedNow.getTime() + 15 * 60 * 1000).toISOString(),
      },
      { commandId: 'cmd-comp2', idempotencyKey: 'idem-comp2' },
    );

    // high 读回部分成功 → PARTIAL_SUCCESS，不授予部分新权限
    assert.equal(conclusion.kind, 'MANUAL_INTERVENTION_REQUIRED');
    // 补偿应对当前失败的 high 与已确认的 low 都发出 remove
    assert.ok(partial.calls.some((c) => c.startsWith('remove:') && c.includes('low')));
    assert.ok(partial.calls.some((c) => c.startsWith('remove:') && c.includes('high')));
    // 校验残留：low 与 high 都不应残留新增成员（全部回滚）
    const lowGroup = store.groups.get(groupRefKey(addLow));
    const highGroup = store.groups.get(groupRefKey(addHigh));
    assert.deepEqual(lowGroup?.memberIds ?? [], []);
    assert.deepEqual(highGroup?.memberIds ?? [], []);
  });
});
