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
    await mappings.saveSubjectMapping({
      localSubjectId: 'u2',
      externalSubjectId: 'u2',
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

    const service = new CasdoorReconcileService(store, mappings, clock);
    const run = await service.runFullReconciliation({
      runId: 'run-1',
      scope: 'platform',
      watermark: 'w1',
      limit: 1,
    });
    assert.equal(run.status, 'COMPLETE_SUCCESS');
    assert.ok(run.pageCount >= 4);
    assert.ok(run.evidence.length >= run.pageCount);
    assert.equal(run.differenceSummary['account.externalOnly'] ?? 0, 0);
    assert.equal(run.differenceSummary['account.localOnly'] ?? 0, 0);
    assert.equal(run.differenceSummary['group.externalOnly'] ?? 0, 0);
    assert.equal(run.differenceSummary['relation.localOnly'] ?? 0, 0);
  });

  it('本地缺映射/关系时产出候选差异摘要并标记部分成功', async () => {
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
    const mappings = new InMemoryMappingStore();
    // 仅 u1 有本地映射，且本地登记的当前关系指向外部并不存在的 g2
    await mappings.saveSubjectMapping({
      localSubjectId: 'u1',
      externalSubjectId: 'u1',
      instance: 'https://cas.example',
      status: 'BOUND',
      firstVerifiedAt: fixedNow.toISOString(),
      lastVerifiedAt: fixedNow.toISOString(),
      history: [],
    });
    await mappings.saveRelation({
      localSubjectId: 'u1',
      groupRef: { owner: 'o', name: 'g2' },
      current: true,
      observedAt: fixedNow.toISOString(),
      source: 'LIVE_READ',
    });

    const service = new CasdoorReconcileService(store, mappings, clock);
    const run = await service.runFullReconciliation({
      runId: 'run-3',
      scope: 'platform',
      watermark: 'w3',
      limit: 10,
    });
    assert.equal(run.status, 'PARTIAL_SUCCESS');
    // u2 外部存在但无本地映射；g 外部存在但无本地映射；u1@g 外部关系本地未登记
    assert.equal(run.differenceSummary['account.externalOnly'], 1);
    assert.equal(run.differenceSummary['group.externalOnly'], 1);
    assert.equal(run.differenceSummary['relation.externalOnly'], 1);
    // 本地登记的 u1@g2 关系外部不存在
    assert.equal(run.differenceSummary['relation.localOnly'], 1);
    assert.equal(run.differenceSummary['account.localOnly'] ?? 0, 0);
  });

  it('扫描中途响应不确定 → 状态为 UNCERTAIN，不推断完整', async () => {
    const store = new InMemoryCasdoorStore({
      users: [{ externalId: 'u1', name: 'A', state: 'ACTIVE' }],
    });
    const mappings = new InMemoryMappingStore();
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
    const uncertainService = new CasdoorReconcileService(uncertainRead, mappings, clock);
    const run = await uncertainService.runFullReconciliation({
      runId: 'run-2',
      scope: 'platform',
      watermark: 'w2',
      limit: 10,
    });
    assert.equal(run.status, 'UNCERTAIN');
  });
});