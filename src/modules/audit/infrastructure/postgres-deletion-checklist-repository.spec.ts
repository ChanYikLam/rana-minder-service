import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresDeletionChecklistRepository } from './postgres-deletion-checklist-repository';
import { DeletionScopeKind, DeletionStepStatus } from '../domain/models/deletion';
import type { DeletionChecklist } from '../domain/models/deletion';

/** fake DbAdapter：内存行存储 + SQL 匹配，模拟事务与 RLS 契约 */
const makeFakeDb = (rows: Record<string, unknown>[]) => {
  const store = [...rows];
  const calls: string[] = [];
  const db = {
    beginTransaction: async () => ({ id: 'tx1' }),
    commit: async () => undefined,
    rollback: async () => undefined,
    setRlsContext: async () => undefined,
    clearRlsContext: async () => undefined,
    query: async (_tx: unknown, sql: string, params: unknown[]) => {
      calls.push(sql);
      // SELECT 行 → 返回匹配（按 checklist_id 过滤；解析 completed = false 条件）
      if (/^SELECT checklist_id/.test(sql.trim())) {
        const id = params[0];
        const filterCompleted = sql.includes('completed = false');
        return store.filter(
          (r) =>
            (id === undefined ? true : r.checklist_id === id) &&
            (filterCompleted ? r.completed === false : true),
        );
      }
      // SELECT version（FOR UPDATE）→ 返回存储中该行真实版本（供锁内版本比较）
      if (/^SELECT version/.test(sql.trim())) {
        const r = store.find((x) => x.checklist_id === params[0]);
        return [{ version: r?.version ?? 1 }];
      }
      if (/^INSERT/.test(sql.trim())) {
        const row: Record<string, unknown> = { checklist_id: params[0] };
        store.push(row);
        return [];
      }
      if (/^UPDATE/.test(sql.trim())) {
        // 列顺序与仓储 UPDATE 逐位对齐：$13 retry_count / $14 version / $15 audit_committed / $16 needs_manual_review / $17 current.version
        const id = params[0];
        const currentVersion = params[16];
        const idx = store.findIndex((r) => r.checklist_id === id && r.version === currentVersion);
        if (idx === -1) return [];
        store[idx] = {
          ...store[idx],
          completed: params[10],
          replay_count: params[11],
          retry_count: params[12],
          version: params[13],
          audit_committed: params[14],
          needs_manual_review: params[15],
        };
        return [];
      }
      return [];
    },
  };
  return { db: db as never, calls, getStore: () => store };
};

const makeRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  checklist_id: 'cl-1',
  scope: JSON.stringify({ kind: DeletionScopeKind.USER_ALL_DATA, principalId: 'u1' }),
  reason: '用户申请',
  purpose: 'LEGAL_REQUIREMENT',
  initiated_by: 'sa1',
  initiated_at: '2026-08-23T10:00:00.000Z',
  confirmed: true,
  affected_objects: JSON.stringify(['报名:r1']),
  business_relations_ended: true,
  steps: JSON.stringify([
    {
      stepId: 's1',
      kind: 'ONLINE_DB',
      targetRef: 'db:user:u1',
      status: DeletionStepStatus.PENDING,
      retryCount: 0,
    },
  ]),
  completed: false,
  replay_count: 0,
  version: 1,
  audit_committed: false,
  ...overrides,
});

describe('PostgresDeletionChecklistRepository（评审补测：防 SQL 列缺失回归）', () => {
  it('listIncomplete/listAll 返回完整字段（含 audit_committed），不漏列（回归用例）', async () => {
    const fake = makeFakeDb([
      makeRow({ checklist_id: 'cl-1', completed: false, audit_committed: true }),
      makeRow({ checklist_id: 'cl-2', completed: true, audit_committed: true }),
    ]);
    const repo = new PostgresDeletionChecklistRepository(fake.db);
    const all = await repo.listAll();
    assert.equal(all.length, 2);
    // audit_committed 必须为 boolean（undefined 会破坏幂等判断）
    for (const c of all) {
      assert.equal(typeof c.auditCommitted, 'boolean');
    }
    const incomplete = await repo.listIncomplete();
    assert.equal(incomplete.length, 1);
    assert.equal(incomplete[0].checklistId, 'cl-1');
    assert.equal(incomplete[0].auditCommitted, true);
  });

  it('fromRow 兼容字符串/Date 两种 initiated_at（适配层类型统一）', async () => {
    const fake = makeFakeDb([makeRow({ initiated_at: '2026-08-23T10:00:00.000Z' })]);
    const repo = new PostgresDeletionChecklistRepository(fake.db);
    const loaded = await repo.load('cl-1');
    assert.equal(loaded!.initiatedAt, '2026-08-23T10:00:00.000Z');
  });

  it('compareAndSwap 版本不匹配 → 拒绝（乐观锁单胜者）', async () => {
    const fake = makeFakeDb([makeRow({ version: 1 })]);
    const repo = new PostgresDeletionChecklistRepository(fake.db);
    const current = (await repo.load('cl-1'))!;
    const next: DeletionChecklist = {
      ...current,
      completed: true,
      version: 2,
      auditCommitted: true,
    };
    const ok = await repo.compareAndSwap(current, next);
    assert.equal(ok, true);
    const stale = await repo.compareAndSwap(
      { ...current, version: 1 }, // 旧版本
      next,
    );
    assert.equal(stale, false);
  });
});
