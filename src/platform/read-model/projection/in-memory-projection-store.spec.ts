import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryProjectionStore } from './in-memory-projection-store';
import { ProjectionRecordStatus } from '../contracts';
import type { ProjectionRecord, ProjectionScope } from '../contracts';

const TYPE = 'PUBLIC_DIRECTORY' as const;

const clubScope = (clubId: string): ProjectionScope => ({ kind: 'CLUB', clubId });

const record = (scope: ProjectionScope, sourceVersion = 1, derivedVersion = 1): ProjectionRecord => ({
  projectionType: TYPE,
  source: { objectType: 'CLUB', objectId: scope.clubId ?? 'x', version: sourceVersion, scope },
  watermark: {
    projectionType: TYPE,
    scope,
    formatVersion: 'v1',
    sourceVersion,
    derivedVersion,
    generatedAt: '2026-08-17T00:00:00.000Z',
  },
  data: { items: [] },
  status: ProjectionRecordStatus.ACTIVE,
  rebuildBasis: 'test',
});

describe('InMemoryProjectionStore（C2.1 冷缓存/清空/过期 + C1.4 作用域隔离）', () => {
  it('冷缓存：未保存时 load 返回 null', async () => {
    const store = new InMemoryProjectionStore();
    assert.equal(await store.load(TYPE, clubScope('c1')), null);
  });

  it('保存后可加载；失效后 load 返回 null', async () => {
    const store = new InMemoryProjectionStore();
    const scope = clubScope('c1');
    await store.save(record(scope));
    assert.ok(await store.load(TYPE, scope));

    await store.invalidate(TYPE, scope, '2026-08-17T00:00:00Z', 'evt-1');
    assert.equal(await store.load(TYPE, scope), null);
  });

  it('作用域隔离：跨社团/跨作用域绝不命中（C1.4 跨作用域负向）', async () => {
    const store = new InMemoryProjectionStore();
    await store.save(record(clubScope('c1')));
    // 不同 clubId → 不命中
    assert.equal(await store.load(TYPE, clubScope('c2')), null);
    // 缺 clubId（作用域不完整）→ 不命中
    assert.equal(await store.load(TYPE, { kind: 'CLUB' }), null);
    // kind 不同 → 不命中
    assert.equal(await store.load(TYPE, { kind: 'SUBJECT', subjectId: 'c1' }), null);
  });

  it('TTL 过期：到期后 load 返回 null（C2.1 过期语义）', async () => {
    const store = new InMemoryProjectionStore();
    const scope = clubScope('c1');
    await store.save(record(scope), { ttlMs: -1 }); // 立即过期
    assert.equal(await store.load(TYPE, scope), null);
  });

  it('clear：全量清空', async () => {
    const store = new InMemoryProjectionStore();
    await store.save(record(clubScope('c1')));
    await store.save(record(clubScope('c2')));
    await store.clear();
    assert.equal(await store.load(TYPE, clubScope('c1')), null);
    assert.equal(await store.load(TYPE, clubScope('c2')), null);
  });

  it('clear：按类型与按作用域', async () => {
    const store = new InMemoryProjectionStore();
    await store.save(record(clubScope('c1')));
    await store.save(record(clubScope('c2')));
    await store.clear(TYPE, clubScope('c1'));
    assert.equal(await store.load(TYPE, clubScope('c1')), null);
    assert.ok(await store.load(TYPE, clubScope('c2')));
  });

  it('重建回源：save 幂等覆盖同作用域旧值', async () => {
    const store = new InMemoryProjectionStore();
    const scope = clubScope('c1');
    await store.save(record(scope, 1, 1));
    await store.save(record(scope, 2, 2));
    const loaded = await store.load<{ items: readonly unknown[] }>(TYPE, scope);
    assert.equal(loaded?.watermark.sourceVersion, 2);
    assert.equal(loaded?.watermark.derivedVersion, 2);
  });
});
