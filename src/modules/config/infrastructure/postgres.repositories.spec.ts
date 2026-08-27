/**
 * PostgresConfigRootRepository 并发保护单测（CFG-005 评审收口）。
 *
 * 覆盖：findForUpdate 根行查询必须携带 FOR UPDATE 行锁（事务内串行化并发
 * 建草稿/发布/回滚）；find 保持普通读（查询路径不加锁）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PostgresConfigRootRepository } from './postgres.repositories';

function makeContext(rootRows: Array<Record<string, unknown>>) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const db = {
    query: async <T>(_tx: unknown, sql: string, params: readonly unknown[]): Promise<T[]> => {
      calls.push({ sql, params });
      if (sql.includes('FROM public.config_roots')) {
        return rootRows as T[];
      }
      return [] as T[]; // config_versions 无行
    },
  };
  const uow = {
    active: { tx: 1 },
    runShared: async <T>(_scope: unknown, fn: () => Promise<T>): Promise<T> => fn(),
  };
  return { repo: new PostgresConfigRootRepository(db as never, uow as never), calls };
}

describe('PostgresConfigRootRepository.findForUpdate（CFG-005 并发发布保护）', () => {
  it('findForUpdate：根行查询携带 FOR UPDATE 行锁', async () => {
    const { repo, calls } = makeContext([
      { kind: 'PLATFORM_POLICY', current_published_version_number: null },
    ]);
    const snap = await repo.findForUpdate('policy');
    assert.ok(snap, '根存在应返回快照');
    const rootSql = calls.find((c) => c.sql.includes('FROM public.config_roots'));
    assert.ok(rootSql, '必须发出根行查询');
    assert.match(rootSql!.sql, /FOR UPDATE/, '根行查询必须加行锁（并发版本操作串行化）');
  });

  it('find：不加锁（查询路径保持普通读，不为只读用例持锁）', async () => {
    const { repo, calls } = makeContext([
      { kind: 'PLATFORM_POLICY', current_published_version_number: null },
    ]);
    await repo.find('policy');
    const rootSql = calls.find((c) => c.sql.includes('FROM public.config_roots'));
    assert.ok(rootSql);
    assert.ok(!/FOR UPDATE/.test(rootSql!.sql), 'find 不应加锁');
  });

  it('findForUpdate：根不存在返回 null（并发首建由 root_id 唯一约束兜底）', async () => {
    const { repo } = makeContext([]);
    assert.equal(await repo.findForUpdate('ghost'), null);
  });
});
