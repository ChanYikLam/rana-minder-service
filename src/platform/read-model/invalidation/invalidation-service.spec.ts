import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CacheInvalidationService } from './invalidation-service';
import { TypeBasedInvalidationRule } from './invalidation-rule';
import { InMemoryProjectionStore } from '../projection/in-memory-projection-store';
import type { RecomputeIntent } from '../contracts';
import type { InvalidationEvent } from './invalidation-event';

const TYPE = 'PERSONAL_CENTER' as const;
const OTHER = 'CLUB_WORKBENCH' as const;

const scope = { kind: 'SUBJECT', subjectId: 'u1' } as const;
const source = {
  objectType: 'PERSON',
  objectId: 'u1',
  version: 3,
  scope: scope as never,
};

const event = (overrides: Partial<InvalidationEvent> = {}): InvalidationEvent => ({
  eventId: 'evt-1',
  type: 'PERMISSION_TIGHTENED',
  source: source as never,
  scope: scope as never,
  occurredAt: '2026-08-17T00:00:00.000Z',
  ...overrides,
});

const makeService = () => {
  const store = new InMemoryProjectionStore();
  const submitted: RecomputeIntent[] = [];
  const indexInvalidated: InvalidationEvent[] = [];
  const registry = {
    list: () => [{ projectionType: TYPE }, { projectionType: OTHER }],
  } as never;
  const service = new CacheInvalidationService(
    registry,
    store,
    { submit: async (i: RecomputeIntent) => void submitted.push(i) } as never,
    { invalidate: async (e: InvalidationEvent) => void indexInvalidated.push(e) } as never,
  );
  service.registerRule(new TypeBasedInvalidationRule(TYPE, ['PERMISSION_TIGHTENED']));
  service.registerRule(new TypeBasedInvalidationRule(OTHER, ['SOURCE_STATE_CHANGED']));
  return { service, store, submitted, indexInvalidated };
};

describe('CacheInvalidationService（C4.4 失效语义 + C4.2 索引失效）', () => {
  it('受影响投影被标记失效（load 返回 null，不再新鲜）', async () => {
    const { service, store } = makeService();
    await store.save({
      projectionType: TYPE,
      source: source as never,
      watermark: { projectionType: TYPE, scope: scope as never, formatVersion: 'v1', sourceVersion: 3, derivedVersion: 1, generatedAt: 'x' },
      data: {},
      status: 'ACTIVE',
      rebuildBasis: 'x',
    } as never);
    await service.onInvalidation(event());
    assert.equal(await store.load(TYPE, scope as never), null);
  });

  it('未受影响投影不失效（规则过滤）', async () => {
    const { service, store } = makeService();
    await store.save({
      projectionType: OTHER,
      source: source as never,
      watermark: { projectionType: OTHER, scope: scope as never, formatVersion: 'v1', sourceVersion: 3, derivedVersion: 1, generatedAt: 'x' },
      data: {},
      status: 'ACTIVE',
      rebuildBasis: 'x',
    } as never);
    // PERMISSION_TIGHTENED 只影响 PERSONAL_CENTER，不影响 CLUB_WORKBENCH
    await service.onInvalidation(event());
    assert.ok(await store.load(OTHER, scope as never));
  });

  it('登记重算意图（intentId=inv-<eventId>，refresh 消费接力）', async () => {
    const { service, submitted } = makeService();
    await service.onInvalidation(event());
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].intentId, 'inv-evt-1');
    assert.equal(submitted[0].reason, 'SCOPE_TIGHTENED');
  });

  it('索引失效端口被调用且幂等标识为 eventId（C4.2）', async () => {
    const { service, indexInvalidated } = makeService();
    await service.onInvalidation(event());
    await service.onInvalidation(event({ eventId: 'evt-2' }));
    assert.equal(indexInvalidated.length, 2);
    assert.equal(indexInvalidated[0].eventId, 'evt-1');
    assert.equal(indexInvalidated[1].eventId, 'evt-2');
  });

  it('正式删除事件 → 失效并登记 SOURCE_DELETED 重算（IFC-TX-007 覆盖派生记录）', async () => {
    const { service, submitted } = makeService();
    await service.onInvalidation(event({ type: 'SOURCE_DELETED' }));
    assert.equal(submitted.length, 0); // SOURCE_DELETED 未注册到任何投影 → 不登记
    // 为删除事件注册规则后应登记
    const service2 = makeService();
    service2.service.registerRule(new TypeBasedInvalidationRule(TYPE, ['SOURCE_DELETED']));
    await service2.service.onInvalidation(event({ type: 'SOURCE_DELETED' }));
    assert.equal(service2.submitted.length, 1);
    assert.equal(service2.submitted[0].reason, 'SOURCE_DELETED');
  });
});
