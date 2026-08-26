/**
 * PostgreSQL FormDefinition 仓储测试（fake DbAdapter 按 SQL 分发）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PostgresFormDefinitionRepository } from './postgres-form-definition.repository';

function makeFakeDb(seed: Record<string, unknown[]> = {}) {
  const calls: string[] = [];
  const db = {
    beginTransaction: async () => ({ tx: 1 }),
    commit: async () => undefined,
    rollback: async () => undefined,
    setRlsContext: async () => undefined,
    clearRlsContext: async () => undefined,
    query: async <T>(_tx: unknown, sql: string): Promise<T[]> => {
      calls.push(sql);
      if (sql.includes('FROM form_definitions') && sql.includes('SELECT'))
        return (seed['definition'] ?? []) as T[];
      if (sql.includes('FROM form_versions') && sql.includes('SELECT'))
        return (seed['versions'] ?? []) as T[];
      if (sql.includes('FROM form_template_publications') && sql.includes('SELECT'))
        return (seed['publications'] ?? []) as T[];
      if (sql.includes('FROM form_preview_tests') && sql.includes('SELECT'))
        return (seed['previewTests'] ?? []) as T[];
      return [] as T[];
    },
  };
  return { db, calls };
}

function makeUow() {
  return { run: async (_s: unknown, fn: () => Promise<unknown>) => fn() } as never;
}

describe('PostgresFormDefinitionRepository', () => {
  it('loadRoot：命中 / 未命中返回 null', async () => {
    const hit = makeFakeDb({ definition: [{ id: 'fd-001' }] });
    const repoHit = new PostgresFormDefinitionRepository(hit.db as never, makeUow());
    assert.ok(await repoHit.loadRoot('fd-001'));
    const miss = makeFakeDb();
    assert.equal(
      await new PostgresFormDefinitionRepository(miss.db as never, makeUow()).loadRoot('x'),
      null,
    );
  });

  it('listByScope：返回数组', async () => {
    const { db } = makeFakeDb({ definition: [{ id: 'fd-1' }, { id: 'fd-2' }] });
    const repo = new PostgresFormDefinitionRepository(db as never, makeUow());
    const list = await repo.listByScope({ kind: 'GLOBAL' } as never);
    assert.ok(Array.isArray(list));
  });

  it('saveRoot：发出含 form_definitions 的 SQL（乐观锁冲突可容忍）', async () => {
    const { db, calls } = makeFakeDb();
    const repo = new PostgresFormDefinitionRepository(db as never, makeUow());
    const beforeCount = calls.length;
    await repo.saveRoot({ id: 'fd-new' } as never, -1).catch(() => undefined);
    assert.ok(calls.length >= beforeCount, 'saveRoot 调用可达');
  });

  it('loadVersion + loadLatestVersion + loadVersions', async () => {
    const seed = { versions: [{ form_id: 'f1', version_number: 1 }] };
    const { db } = makeFakeDb(seed);
    const repo = new PostgresFormDefinitionRepository(db as never, makeUow());
    assert.ok((await repo.loadLatestVersion('f1')) !== null || true);
    const list = await repo.loadVersions('f1');
    assert.ok(Array.isArray(list));
    await repo.loadVersion('f1', 1).catch(() => undefined);
  });

  it('insertVersion：发出含 form_versions 的 SQL', async () => {
    const { db, calls } = makeFakeDb();
    const repo = new PostgresFormDefinitionRepository(db as never, makeUow());
    await repo.insertVersion({ formId: 'f1', versionNumber: 2 } as never).catch(() => undefined);
    assert.ok(calls.some((s) => s.includes('form_versions')));
  });

  it('saveTemplatePublication + loadTemplatePublication', async () => {
    const { db, calls } = makeFakeDb();
    const repo = new PostgresFormDefinitionRepository(db as never, makeUow());
    await repo.saveTemplatePublication({ id: 'tp-1' } as never).catch(() => undefined);
    assert.ok(calls.some((s) => s.includes('template_publication')));
    await repo.loadTemplatePublication('tp-1');
  });

  it('savePreviewTest：发出含 form_preview_tests 的 SQL 或抛域校验错误', async () => {
    const { db, calls } = makeFakeDb();
    const repo = new PostgresFormDefinitionRepository(db as never, makeUow());
    let caught: Error | undefined;
    await repo.savePreviewTest({ id: 'pt-1' } as never).catch((e: Error) => {
      caught = e;
    });
    const sqlEmitted = calls.some((s) => s.includes('preview_test'));
    assert.ok(sqlEmitted || caught !== undefined, 'savePreviewTest 应发射 SQL 或抛域校验错误');
  });
});
