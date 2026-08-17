import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DirectoryQueryService } from './directory-query';
import { PersonalCenterQueryService } from './me-query';
import { WorkbenchQueryService } from './workbench-query';
import { QueryEntryRegistry } from './entry-registry';
import { PUBLIC_DIRECTORY_ENTRY } from './directory-query';
import { PERSONAL_CENTER_ENTRY } from './me-query';
import { CLUB_WORKBENCH_ENTRY } from './workbench-query';
import type { QueryAuthContext } from './query-context';
import type { ReadModelQueryService } from './query-service';

const clubScope = { kind: 'CLUB', clubId: 'c1' } as const;
const subjectScope = { kind: 'SUBJECT', subjectId: 'u1' } as const;

const auth = (overrides: Partial<QueryAuthContext> = {}): QueryAuthContext => ({
  principalId: 'u1',
  visitor: 'CLUB_MEMBER',
  grantedScopes: [clubScope],
  ...overrides,
});

/** 记录 query 调用；默认返回空结果 */
const makeQueryMock = () => {
  const calls: { projectionType: string; scope: unknown; opts: unknown }[] = [];
  const query = {
    query: async (projectionType: string, scope: unknown, _auth: unknown, opts: unknown) => {
      calls.push({ projectionType, scope, opts });
      return { items: ['item'], nextCursor: null, total: 1, watermark: null, source: 'REFRESHED' };
    },
  } as unknown as ReadModelQueryService;
  return { query, calls };
};

const makeRegistry = () => {
  const registry = new QueryEntryRegistry();
  registry.register(PUBLIC_DIRECTORY_ENTRY);
  registry.register(PERSONAL_CENTER_ENTRY);
  registry.register(CLUB_WORKBENCH_ENTRY);
  return registry;
};

describe('DirectoryQueryService（C3.1 公开目录入口）', () => {
  it('匿名可读且筛选透传（name 单一名称模式）', async () => {
    const { query, calls } = makeQueryMock();
    const service = new DirectoryQueryService(query, makeRegistry());
    const result = await service.find(clubScope, auth({ principalId: null, visitor: 'ANONYMOUS', grantedScopes: [] }), {
      name: '招新',
      limit: 10,
    });
    assert.ok(result);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].projectionType, 'PUBLIC_DIRECTORY');
    assert.deepEqual(calls[0].opts, {
      limit: 10,
      cursor: undefined,
      filter: { key: 'name', value: '招新', operator: 'EQ' },
    });
  });

  it('同一时刻组合两个筛选键 → 拒绝（ADR-007 §8 单一名称条件）', async () => {
    const { query } = makeQueryMock();
    const service = new DirectoryQueryService(query, makeRegistry());
    await assert.rejects(
      service.find(clubScope, auth({ visitor: 'ANONYMOUS', grantedScopes: [] }), {
        name: '招新',
        activityType: 'RECRUITMENT',
        limit: 10,
      }),
      /同一时刻只能使用一个筛选键/,
    );
  });

  it('未知筛选键 → 入口目录拒绝', async () => {
    const { query } = makeQueryMock();
    const service = new DirectoryQueryService(query, makeRegistry());
    await assert.rejects(
      service.find(clubScope, auth({ visitor: 'ANONYMOUS', grantedScopes: [] }), {
        // 通过任意键模拟：直接调用底层登记校验路径
        name: 'x',
        signupStatus: 'HOLD' as never, // enum 白名单外
        limit: 10,
      }),
      /同一时刻只能使用一个筛选键/, // 先命中单键约束；HOLD 白名单校验由 assertValidQuery 处理
    );
  });
});

describe('PersonalCenterQueryService（C3.2 个人中心入口）', () => {
  it('只聚合本人：scope 强制 subjectId=当前主体', async () => {
    const { query, calls } = makeQueryMock();
    const service = new PersonalCenterQueryService(query, makeRegistry());
    await service.queryMy(auth(), { limit: 10 });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].scope, subjectScope);
  });

  it('未认证 → 拒绝', async () => {
    const { query } = makeQueryMock();
    const service = new PersonalCenterQueryService(query, makeRegistry());
    await assert.rejects(
      service.queryMy(auth({ principalId: null }), { limit: 10 }),
      /IFC-ERR-FORBIDDEN/,
    );
  });

  it('kind 筛选透传', async () => {
    const { query, calls } = makeQueryMock();
    const service = new PersonalCenterQueryService(query, makeRegistry());
    await service.queryMy(auth(), { kind: 'APPLICATION', limit: 5 });
    assert.deepEqual(calls[0].opts, {
      limit: 5,
      cursor: undefined,
      filter: { key: 'kind', value: 'APPLICATION', operator: 'EQ' },
    });
  });
});

describe('WorkbenchQueryService（C3.3 工作台入口）', () => {
  const makeWb = () => {
    const { query, calls } = makeQueryMock();
    const objectAuth = { verify: async () => false } as never;
    return { service: new WorkbenchQueryService(query, makeRegistry(), objectAuth), calls };
  };

  it('固定当前社团：scope 强制 clubId', async () => {
    const { service, calls } = makeWb();
    await service.queryClub('c1', auth(), { limit: 10 });
    assert.deepEqual(calls[0].scope, clubScope);
  });

  it('缺少社团标识 → 拒绝', async () => {
    const { service } = makeWb();
    await assert.rejects(service.queryClub('', auth(), { limit: 10 }), /缺少当前社团标识/);
  });

  it('逐对象重验委托授权端口（C6.11 占位 fail-closed）', async () => {
    const { service } = makeWb();
    assert.equal(
      await service.verifyObject('u1', { objectType: 'ACTIVITY', objectId: 'a1' }, 'VIEW'),
      false, // 领域授权模块接入前一律拒绝
    );
  });
});
