import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QueryEntryRegistry } from './entry-registry';
import { PUBLIC_DIRECTORY_ENTRY } from './directory-query';
import { PERSONAL_CENTER_ENTRY } from './me-query';
import { CLUB_WORKBENCH_ENTRY } from './workbench-query';

const clubScope = { kind: 'CLUB', clubId: 'c1' } as const;
const subjectScope = { kind: 'SUBJECT', subjectId: 'u1' } as const;

const makeRegistry = () => {
  const registry = new QueryEntryRegistry();
  registry.register(PUBLIC_DIRECTORY_ENTRY);
  registry.register(PERSONAL_CENTER_ENTRY);
  registry.register(CLUB_WORKBENCH_ENTRY);
  return registry;
};

describe('QueryEntryRegistry（IFC-QRY-008 入口登记与负向校验）', () => {
  it('未知入口 → 拒绝', () => {
    const registry = makeRegistry();
    assert.throws(() => registry.get('not-exist'), /IFC-ERR-VALIDATION/);
  });

  it('重复登记同一入口 → 拒绝（配置错误）', () => {
    const registry = makeRegistry();
    assert.throws(() => registry.register(PUBLIC_DIRECTORY_ENTRY), /IFC-ERR-CONFIG/);
  });

  it('未知筛选键 → 拒绝（不静默忽略后返回更宽结果）', () => {
    const registry = makeRegistry();
    assert.throws(
      () =>
        registry.assertValidQuery('public-directory', clubScope, {
          filter: { key: 'unknownKey', value: 'x', operator: 'EQ' },
          limit: 10,
          anonymous: true,
        }),
      /未知筛选键/,
    );
  });

  it('未知操作符 → 拒绝', () => {
    const registry = makeRegistry();
    assert.throws(
      () =>
        registry.assertValidQuery('public-directory', clubScope, {
          filter: { key: 'name', value: 'x', operator: 'NE' as never },
          limit: 10,
          anonymous: true,
        }),
      /未知操作符/,
    );
  });

  it('enum 筛选值不在允许集合 → 拒绝', () => {
    const registry = makeRegistry();
    assert.throws(
      () =>
        registry.assertValidQuery('public-directory', clubScope, {
          filter: { key: 'signupStatus', value: 'HOLD', operator: 'EQ' },
          limit: 10,
          anonymous: true,
        }),
      /不在允许集合内/,
    );
  });

  it('未登记空值语义的筛选键空值 → 拒绝', () => {
    const registry = makeRegistry();
    assert.throws(
      () =>
        registry.assertValidQuery('public-directory', clubScope, {
          filter: { key: 'name', value: '', operator: 'EQ' },
          limit: 10,
          anonymous: true,
        }),
      /不允许空值/,
    );
  });

  it('排序不在白名单 → 拒绝', () => {
    const registry = makeRegistry();
    assert.throws(
      () =>
        registry.assertValidQuery('public-directory', clubScope, {
          sort: 'RANDOM' as never,
          limit: 10,
          anonymous: true,
        }),
      /未知排序/,
    );
  });

  it('分页超上限 → 拒绝', () => {
    const registry = makeRegistry();
    assert.throws(
      () =>
        registry.assertValidQuery('public-directory', clubScope, { limit: 101, anonymous: true }),
      /limit 必须为 1\.\.100/,
    );
  });

  it('作用域种类不匹配 → 拒绝（me 要求 SUBJECT，传 CLUB）', () => {
    const registry = makeRegistry();
    assert.throws(
      () =>
        registry.assertValidQuery('personal-center', clubScope, { limit: 10, anonymous: false }),
      /要求作用域 SUBJECT/,
    );
  });

  it('未认证 + allowAnonymous=false → 拒绝', () => {
    const registry = makeRegistry();
    assert.throws(
      () => registry.assertValidQuery('club-workbench', clubScope, { limit: 10, anonymous: true }),
      /需要认证/,
    );
  });

  it('RANGE：起止对象且至少一端，非法时间拒绝（C6.7 自定义起止）', () => {
    const registry = makeRegistry();
    // 合法 RANGE：deadline 键已登记 RANGE
    assert.doesNotThrow(() =>
      registry.assertValidQuery('public-directory', clubScope, {
        filter: { key: 'deadline', value: { from: '2026-08-18' }, operator: 'RANGE' },
        limit: 10,
        anonymous: true,
      }),
    );
    // 两端都缺 → 拒绝
    assert.throws(
      () =>
        registry.assertValidQuery('public-directory', clubScope, {
          filter: { key: 'deadline', value: {}, operator: 'RANGE' },
          limit: 10,
          anonymous: true,
        }),
      /至少一端起止/,
    );
    // 非法时间 → 拒绝
    assert.throws(
      () =>
        registry.assertValidQuery('public-directory', clubScope, {
          filter: { key: 'deadline', value: { to: 'not-a-date' }, operator: 'RANGE' },
          limit: 10,
          anonymous: true,
        }),
      /不是合法时间/,
    );
    // 未登记 RANGE 的键（name）用 RANGE → 拒绝（未知操作符）
    assert.throws(
      () =>
        registry.assertValidQuery('public-directory', clubScope, {
          filter: { key: 'name', value: { from: 'a' }, operator: 'RANGE' },
          limit: 10,
          anonymous: true,
        }),
      /未知操作符/,
    );
  });

  it('公开目录允许匿名 + 合法筛选通过', () => {
    const registry = makeRegistry();
    assert.doesNotThrow(() =>
      registry.assertValidQuery('public-directory', clubScope, {
        filter: { key: 'signupStatus', value: 'OPEN', operator: 'EQ' },
        limit: 20,
        anonymous: true,
      }),
    );
  });
});
