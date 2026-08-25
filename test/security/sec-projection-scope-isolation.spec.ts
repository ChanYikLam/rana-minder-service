/**
 * 安全控制独立验证：SEC-CTL-006（失权传播）/ SEC-CTL-013（社团域隔离）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5、§7.2/§7.4。
 *
 * 验证路径（真实代码，无 pg/jose 依赖）：
 * - src/platform/read-model/projection/in-memory-projection-store.ts
 *   （缓存键含作用域维度；INVALIDATED/TTL 不作新鲜结果返回）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryProjectionStore } from '../../src/platform/read-model/projection/in-memory-projection-store';
import {
  ProjectionRecordStatus,
  type ProjectionRecord,
} from '../../src/platform/read-model/contracts/projection-record';
import type { ProjectionScope } from '../../src/platform/read-model/contracts/scope';
import { ProjectionType } from '../../src/platform/read-model/contracts/projection-type';

const clubA: ProjectionScope = { kind: 'CLUB', clubId: 'club-A' };
const clubB: ProjectionScope = { kind: 'CLUB', clubId: 'club-B' };

function record(scope: ProjectionScope, data: string, sourceVersion = 1): ProjectionRecord<string> {
  return {
    projectionType: ProjectionType.CLUB_WORKBENCH,
    source: {
      objectType: 'CLUB',
      objectId: scope.clubId ?? 'platform',
      version: sourceVersion,
      scope,
    },
    watermark: {
      projectionType: ProjectionType.CLUB_WORKBENCH,
      scope,
      formatVersion: 'v1',
      sourceVersion,
      derivedVersion: 1,
      generatedAt: new Date(0).toISOString(),
    },
    data,
    status: ProjectionRecordStatus.ACTIVE,
    rebuildBasis: 'test://rebuild',
  };
}

describe('SEC-CTL-006 失权后派生结果立即失效', () => {
  it('SEC-CTL-006：显式失效后旧投影不再作为新鲜结果返回（旧缓存不放权）', async () => {
    const store = new InMemoryProjectionStore();
    await store.save(record(clubA, 'workbench-v1'));

    const before = await store.load<string>(ProjectionType.CLUB_WORKBENCH, clubA);
    assert.equal(before?.data, 'workbench-v1');

    await store.invalidate(
      ProjectionType.CLUB_WORKBENCH,
      clubA,
      '2026-08-24T08:00:00Z',
      'role-revoked',
    );

    const after = await store.load<string>(ProjectionType.CLUB_WORKBENCH, clubA);
    assert.equal(after, null, '失权后必须回源重验，不得以旧投影继续放权');
  });

  it('SEC-CTL-006：TTL 到期后投影过期清退，冷读取为 null（可重建语义）', async () => {
    const store = new InMemoryProjectionStore();
    await store.save(record(clubA, 'stale'), { ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 10));
    const loaded = await store.load<string>(ProjectionType.CLUB_WORKBENCH, clubA);
    assert.equal(loaded, null);
  });

  it('SEC-CTL-006：对不存在投影执行失效是安全无副作用操作', async () => {
    const store = new InMemoryProjectionStore();
    await store.invalidate(ProjectionType.CLUB_WORKBENCH, clubB, '2026-08-24T08:00:00Z', 'noop');
    const loaded = await store.load<string>(ProjectionType.CLUB_WORKBENCH, clubB);
    assert.equal(loaded, null);
  });
});

describe('SEC-CTL-013 投影作用域隔离（跨社团绝不命中）', () => {
  it('SEC-CTL-013：社团 A 的投影对社团 B 加载恒为 null', async () => {
    const store = new InMemoryProjectionStore();
    await store.save(record(clubA, 'only-a'));
    const forB = await store.load<string>(ProjectionType.CLUB_WORKBENCH, clubB);
    assert.equal(forB, null, '跨社团缓存命中即信息泄漏渠道');
    const forA = await store.load<string>(ProjectionType.CLUB_WORKBENCH, clubA);
    assert.equal(forA?.data, 'only-a');
  });

  it('SEC-CTL-013：findByScope 只返回本作用域记录，不构成跨社团枚举渠道', async () => {
    const store = new InMemoryProjectionStore();
    await store.save(record(clubA, 'a-1'), {});
    await store.save(record(clubB, 'b-1'), {});

    const scopedA = await store.findByScope<string>(ProjectionType.CLUB_WORKBENCH, clubA);
    assert.equal(scopedA.length, 1);
    assert.equal(scopedA[0]?.data, 'a-1');

    const scopedB = await store.findByScope<string>(ProjectionType.CLUB_WORKBENCH, clubB);
    assert.equal(scopedB.length, 1);
    assert.equal(scopedB[0]?.data, 'b-1');
  });

  it('SEC-CTL-013：主体个人域与社团域互不可见（作用域维度进入缓存键）', async () => {
    const store = new InMemoryProjectionStore();
    const subject: ProjectionScope = { kind: 'SUBJECT', subjectId: 'u1' };
    await store.save(record(subject, 'personal'));
    const asClub = await store.load<string>(ProjectionType.CLUB_WORKBENCH, clubA);
    assert.equal(asClub, null);
    const asSubject = await store.load<string>(ProjectionType.CLUB_WORKBENCH, subject);
    assert.equal(asSubject?.data, 'personal');
  });
});
