import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CasdoorReconcileService } from './casdoor-reconcile.service';
import { InMemoryCasdoorStore } from '../infrastructure/in-memory-casdoor-store';
import { InMemoryMappingStore } from '../infrastructure/in-memory-mapping-store';
import type { ClockPort } from '../contracts/ports';

const fixedNow = new Date('2026-08-20T00:00:00.000Z');
const clock: ClockPort = { now: () => fixedNow };

describe('CasdoorReconcileService', () => {
  it('全量对账分页扫描完成并区分完整成功', async () => {
    const store = new InMemoryCasdoorStore({
      users: [
        { externalId: 'u1', name: 'A', state: 'ACTIVE' },
        { externalId: 'u2', name: 'B', state: 'ACTIVE' },
      ],
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
    const service = new CasdoorReconcileService(store, clock, new InMemoryMappingStore());
    const run = await service.runFullReconciliation({
      runId: 'run-1',
      scope: 'platform',
      watermark: 'w1',
      limit: 1,
    });
    assert.equal(run.status, 'COMPLETE_SUCCESS');
    assert.ok(run.pageCount >= 4);
    assert.ok(run.evidence.length >= run.pageCount);
  });

  it('扫描中途响应不确定 → 状态为 UNCERTAIN，不推断完整', async () => {
    const store = new InMemoryCasdoorStore({
      users: [{ externalId: 'u1', name: 'A', state: 'ACTIVE' }],
    });
    // 用包装端口让第一次账户分页返回不确定。
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
    const uncertainService = new CasdoorReconcileService(uncertainRead, clock, new InMemoryMappingStore());
    const run = await uncertainService.runFullReconciliation({
      runId: 'run-2',
      scope: 'platform',
      watermark: 'w2',
      limit: 10,
    });
    assert.equal(run.status, 'UNCERTAIN');
  });

  it('外部枚举与本地映射比对后产出差异统计', async () => {
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
      localSubjectId: 'local-u1',
      externalSubjectId: 'u1',
      instance: 'test-instance',
      status: 'BOUND',
      firstVerifiedAt: fixedNow.toISOString(),
      lastVerifiedAt: fixedNow.toISOString(),
      history: [],
    });
    await mappings.saveGroupMapping({
      localObjectRef: 'club:g',
      externalRef: { owner: 'o', name: 'g' },
      purpose: 'CLUB',
      status: 'BOUND',
      lastVerifiedAt: fixedNow.toISOString(),
      history: [],
    });
    await mappings.saveRelation({
      localSubjectId: 'local-u1',
      groupRef: { owner: 'o', name: 'g' },
      current: true,
      observedAt: fixedNow.toISOString(),
      source: 'LIVE_READ',
    });

    const service = new CasdoorReconcileService(store, clock, mappings);
    const run = await service.runFullReconciliation({
      runId: 'run-3',
      scope: 'platform',
      watermark: 'w3',
      limit: 10,
    });
    assert.equal(run.status, 'COMPLETE_SUCCESS');
    assert.equal(run.differenceSummary['accountsWithoutLocalMapping'] ?? 0, 0);
    assert.equal(run.differenceSummary['groupsWithoutLocalMapping'] ?? 0, 0);
    assert.equal(run.differenceSummary['relationsMissingLocally'] ?? 0, 0);
  });

  it('外部存在但本地未映射的对象计入差异', async () => {
    const store = new InMemoryCasdoorStore({
      users: [
        { externalId: 'u1', name: 'A', state: 'ACTIVE' },
        { externalId: 'u2', name: 'B', state: 'ACTIVE' },
      ],
      groups: [
        {
          ref: { owner: 'o', name: 'g' },
          displayName: 'G',
          parentRef: null,
          memberIds: ['u1', 'u2'],
          state: 'ACTIVE',
        },
      ],
    });
    const service = new CasdoorReconcileService(store, clock, new InMemoryMappingStore());
    const run = await service.runFullReconciliation({
      runId: 'run-4',
      scope: 'platform',
      watermark: 'w4',
      limit: 10,
    });
    assert.equal(run.differenceSummary['accountsWithoutLocalMapping'], 2);
    assert.equal(run.differenceSummary['groupsWithoutLocalMapping'], 1);
    assert.ok((run.differenceSummary['relationsWithoutLocalMapping'] ?? 0) >= 2);
  });
});
