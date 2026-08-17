import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RefreshHandler } from './refresh-handler';
import { InMemoryProjectionStore } from '../projection/in-memory-projection-store';
import { ProjectionRecordStatus } from '../contracts';
import type { ProjectionRecord, ProjectionScope, RecomputeIntent } from '../contracts';

const TYPE = 'PUBLIC_DIRECTORY' as const;
const scope: ProjectionScope = { kind: 'CLUB', clubId: 'c1' };

const intent = (version: number): RecomputeIntent => ({
  intentId: 'intent-1',
  source: { objectType: 'CLUB', objectId: 'c1', version, scope },
  reason: 'SOURCE_STATE_CHANGED',
  createdAt: '2026-08-17T00:00:00.000Z',
});

const record = (sourceVersion: number): ProjectionRecord => ({
  projectionType: TYPE,
  source: { objectType: 'CLUB', objectId: 'c1', version: sourceVersion, scope },
  watermark: {
    projectionType: TYPE,
    scope,
    formatVersion: 'v1',
    sourceVersion,
    derivedVersion: sourceVersion,
    generatedAt: '2026-08-17T00:00:00.000Z',
  },
  data: { items: ['a'] },
  status: ProjectionRecordStatus.ACTIVE,
  rebuildBasis: 'intent-1',
});

/** rebuild 行为可定制（第二参为 store，用于模拟重建期间的并发写入）；rebuildCalls 记录调用次数 */
const makeService = (
  rebuildImpl: (
    v: number,
    store: InMemoryProjectionStore,
  ) => Promise<ProjectionRecord | null> = async (v) => record(v),
) => {
  const store = new InMemoryProjectionStore();
  const rebuildCalls: number[] = [];
  const registry = {
    get: () => ({
      projectionType: TYPE,
      rebuild: async (s: ProjectionScope, basis: { expectedSourceVersion?: number }) => {
        const v = basis.expectedSourceVersion ?? 0;
        rebuildCalls.push(v);
        return rebuildImpl(v, store);
      },
    }),
    list: () => [{ projectionType: TYPE }],
  } as never;
  return { service: new RefreshHandler(registry, store), store, rebuildCalls };
};

describe('RefreshHandler（C5.4 水位/失败不改源）', () => {
  it('消费 intent 执行重建并保存', async () => {
    const { service, store, rebuildCalls } = makeService();
    await service.consume(intent(3));
    assert.deepEqual(rebuildCalls, [3]);
    const loaded = await store.load(TYPE, scope);
    assert.equal(loaded?.watermark.sourceVersion, 3);
  });

  it('旧水位不覆盖新结果：已有更高源版本时跳过（IFC-TX-008）', async () => {
    const { service, store, rebuildCalls } = makeService();
    await store.save(record(5));
    await service.consume(intent(3)); // intent 源版本 3 < 已有 5 → 跳过
    assert.equal(rebuildCalls.length, 0);
    const loaded = await store.load(TYPE, scope);
    assert.equal(loaded?.watermark.sourceVersion, 5); // 不被旧结果覆盖
  });

  it('源缺失/已删除：rebuild=null → 标记失效而非伪造（R4）', async () => {
    const { service, store, rebuildCalls } = makeService(async () => null);
    await service.consume(intent(3));
    assert.equal(rebuildCalls.length, 1);
    assert.equal(await store.load(TYPE, scope), null); // 已失效，不返回新鲜结果
  });

  it('并发安全：重建返回后若已有更新结果 → 不保存旧水位（二次水位校验）', async () => {
    const { service, store, rebuildCalls } = makeService(async (v, st) => {
      // 模拟重建期间并发写入了更高版本（9 > intent 3）
      await st.save(record(9));
      return record(v);
    });
    await service.consume(intent(3));
    assert.equal(rebuildCalls.length, 1);
    const loaded = await store.load(TYPE, scope);
    assert.equal(loaded?.watermark.sourceVersion, 9); // 旧重建结果被丢弃，不覆盖更新结果
  });

  it('派生失败：异常上抛（由 job 记为可重试失败），不写任何投影', async () => {
    const { service, store } = makeService(async () => {
      throw new Error('authority unavailable');
    });
    await assert.rejects(service.consume(intent(3)), /authority unavailable/);
    assert.equal(await store.load(TYPE, scope), null);
  });
});
