import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ReadModelQueryService } from './query-service';
import { InMemoryProjectionStore } from '../projection/in-memory-projection-store';
import { ProjectionType, ProjectionRecordStatus } from '../contracts';
import type { ProjectionRecord, ProjectionScope } from '../contracts';
import { QuerySource } from './query-result';
import type { QueryAuthContext } from './query-context';
import type { QueryOptions } from './query-options';

const TYPE: ProjectionType = 'PUBLIC_DIRECTORY';
const clubScope = (clubId: string): ProjectionScope => ({ kind: 'CLUB', clubId });
const opts = (overrides: Partial<QueryOptions> = {}): QueryOptions => ({ limit: 10, ...overrides });

const auth = (overrides: Partial<QueryAuthContext> = {}): QueryAuthContext => ({
  principalId: 'u1',
  visitor: 'CLUB_MEMBER',
  grantedScopes: [clubScope('c1')],
  ...overrides,
});

const makeRecord = (scope: ProjectionScope, items: unknown[] = ['a', 'b']): ProjectionRecord => ({
  projectionType: TYPE,
  source: { objectType: 'CLUB', objectId: scope.clubId ?? 'x', version: 1, scope },
  watermark: {
    projectionType: TYPE,
    scope,
    formatVersion: 'v1',
    sourceVersion: 1,
    derivedVersion: 1,
    generatedAt: '2026-08-17T00:00:00.000Z',
  },
  data: items, // 投影 data 即条目数组（paginate 按数组处理）
  status: ProjectionRecordStatus.ACTIVE,
  rebuildBasis: 'test',
});

/** 构造 service：registry 只注册一个 PUBLIC_DIRECTORY builder，rebuild 可定制 */
const makeService = (rebuildImpl?: (scope: ProjectionScope) => Promise<ProjectionRecord | null>) => {
  const store = new InMemoryProjectionStore();
  const registry = {
    get: (t: ProjectionType) => {
      assert.equal(t, TYPE);
      return {
        projectionType: TYPE,
        rebuild: async (scope: ProjectionScope) => (rebuildImpl ? rebuildImpl(scope) : makeRecord(scope)),
      };
    },
    list: () => [],
  } as never;
  return { service: new ReadModelQueryService(registry, store), store };
};

describe('ReadModelQueryService（C3.5 授权/游标/负向）', () => {
  it('未授权作用域 → IFC-ERR-FORBIDDEN（R2 不从投影授权）', async () => {
    const { service } = makeService();
    await assert.rejects(service.query(TYPE, clubScope('c-other'), auth(), opts()), /IFC-ERR-FORBIDDEN/);
  });

  it('公开目录允许匿名读取', async () => {
    const { service } = makeService();
    const result = await service.query(
      TYPE,
      clubScope('c1'),
      auth({ principalId: null, visitor: 'ANONYMOUS', grantedScopes: [] }),
      opts(),
    );
    assert.equal(result.source, QuerySource.REFRESHED);
  });

  it('冷缓存回源重建 → REFRESHED；再次查询命中投影 → PROJECTION', async () => {
    const { service, store } = makeService();
    const scope = clubScope('c1');
    const first = await service.query(TYPE, scope, auth(), opts());
    assert.equal(first.source, QuerySource.REFRESHED);
    assert.ok(await store.load(TYPE, scope)); // 重建结果已持久化
    const second = await service.query(TYPE, scope, auth(), opts());
    assert.equal(second.source, QuerySource.PROJECTION);
  });

  it('源不可用（rebuild=null）→ UNAVAILABLE，不伪造新鲜结果（R4）', async () => {
    const { service } = makeService(async () => null);
    const result = await service.query(TYPE, clubScope('c1'), auth(), opts());
    assert.equal(result.source, QuerySource.UNAVAILABLE);
    assert.equal(result.total, 0);
  });

  it('limit 越界（0 与 101）→ 拒绝', async () => {
    const { service } = makeService();
    await assert.rejects(service.query(TYPE, clubScope('c1'), auth(), opts({ limit: 0 })), /IFC-ERR-VALIDATION/);
    await assert.rejects(service.query(TYPE, clubScope('c1'), auth(), opts({ limit: 101 })), /IFC-ERR-VALIDATION/);
  });

  it('未知操作符 → 拒绝（IFC-QRY-008：未知操作符必须拒绝，不静默放宽）', async () => {
    const { service } = makeService();
    const bad = opts({ filter: { key: 'k', value: 'v', operator: 'NE' as never } });
    await assert.rejects(service.query(TYPE, clubScope('c1'), auth(), bad), /IFC-ERR-VALIDATION/);
  });

  it('损坏游标 → 拒绝', async () => {
    const { service } = makeService();
    await assert.rejects(
      service.query(TYPE, clubScope('c1'), auth(), opts({ cursor: 'not-a-cursor!!' })),
      /IFC-ERR-VALIDATION/,
    );
  });

  it('游标与筛选不匹配 → 拒绝（不静默换结果集）', async () => {
    const { service } = makeService();
    const scope = clubScope('c1');
    const withFilter = opts({ limit: 1, filter: { key: 'status', value: 'OPEN', operator: 'EQ' } });
    const first = await service.query(TYPE, scope, auth(), withFilter);
    assert.ok(first.nextCursor); // limit=1 且 2 条数据 → 必有下一页
    // 换筛选条件后复用旧游标 → 拒绝
    await assert.rejects(
      service.query(TYPE, scope, auth(), opts({ limit: 1, cursor: first.nextCursor ?? undefined })),
      /IFC-ERR-VALIDATION/,
    );
  });

  it('游标跨作用域复用 → 拒绝（C3.4 游标绑定作用域）', async () => {
    const { service } = makeService();
    const first = await service.query(TYPE, clubScope('c1'), auth(), opts({ limit: 1 }));
    assert.ok(first.nextCursor);
    // 用 c1 的游标查 c2 → 拒绝（不静默换结果集）
    await assert.rejects(
      service.query(
        TYPE,
        clubScope('c2'),
        auth({ grantedScopes: [clubScope('c1'), clubScope('c2')] }),
        opts({ limit: 1, cursor: first.nextCursor ?? undefined }),
      ),
      /IFC-ERR-VALIDATION/,
    );
  });

  it('分页：超过 limit 时返回 nextCursor 且条数受限', async () => {
    const { service } = makeService(async (scope) => makeRecord(scope, ['a', 'b', 'c', 'd', 'e']));
    const result = await service.query(TYPE, clubScope('c1'), auth(), opts({ limit: 3 }));
    assert.equal(result.items.length, 3);
    assert.ok(result.nextCursor);
    assert.equal(result.total, 5);
  });

  it('游标跨入口（跨投影类型）复用 → 拒绝（C3.4 游标绑投影类型）', async () => {
    const { service } = makeService();
    const scope = clubScope('c1');
    const first = await service.query(TYPE, scope, auth(), opts({ limit: 1 }));
    assert.ok(first.nextCursor);
    // 以另一投影类型（入口）复用同一游标 → 拒绝（不静默换结果集）
    await assert.rejects(
      service.query(
        'PERSONAL_CENTER' as never,
        scope,
        auth(),
        opts({ limit: 1, cursor: first.nextCursor ?? undefined }),
      ),
      /游标与入口不匹配/,
    );
  });
});
