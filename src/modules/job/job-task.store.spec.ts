/**
 * PostgresJobTaskStore 单元测试（ADR-004 租约执行语义）。
 *
 * 用仿真 DbAdapter（按 job_tasks 表语义执行 claim/complete/retry/fail SQL）
 * 验证：领取只取到期/过期租约任务、单笔 UPDATE 原子、尝试次数递增、
 * 租约过期可重新领取、结算仅限持租约者、RLS 平台级上下文每笔建立并清理。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresJobTaskStore, computeBackoffMs } from './job-task.store';
import type { DbAdapter, RlsScope, TransactionContext } from '../../shared/db-adapter';

interface TaskRow {
  id: string;
  type: string;
  subject_id: string;
  payload: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  next_run_at: Date | null;
  leased_until: Date | null;
  created_at: Date;
  error: string | null;
}

const now = new Date('2026-08-20T12:00:00.000Z');
const minute = 60_000;

function task(overrides?: Partial<TaskRow>): TaskRow {
  return {
    id: 'profile_sync:user-1:phone:4',
    type: 'profile_sync',
    subject_id: 'user-1',
    payload: JSON.stringify({ subjectId: 'user-1', field: 'phone', targetVersion: 4, intentId: 'intent-1' }),
    status: 'pending',
    attempts: 0,
    next_run_at: null,
    leased_until: null,
    created_at: now,
    error: null,
    ...overrides,
  };
}

class FakeJobTaskDb implements DbAdapter {
  rows = new Map<string, TaskRow>();
  readonly events: string[] = [];
  private txCounter = 0;

  seed(...rows: TaskRow[]): void {
    for (const row of rows) {
      this.rows.set(row.id, row);
    }
  }

  async beginTransaction(): Promise<TransactionContext> {
    const tx = { id: `tx-${++this.txCounter}` };
    this.events.push(`begin:${tx.id}`);
    return tx;
  }

  async commit(tx: TransactionContext): Promise<void> {
    this.events.push(`commit:${tx.id}`);
  }

  async rollback(tx: TransactionContext): Promise<void> {
    this.events.push(`rollback:${tx.id}`);
  }

  async setRlsContext(tx: TransactionContext, scope: RlsScope): Promise<void> {
    this.events.push(`set-rls:${tx.id}:${scope.kind}`);
  }

  async clearRlsContext(tx: TransactionContext): Promise<void> {
    this.events.push(`clear-rls:${tx.id}`);
  }

  async query<T>(tx: TransactionContext, sql: string, params: readonly unknown[]): Promise<T[]> {
    this.events.push(`query:${tx.id}`);
    if (sql.includes('RETURNING t.id, t.type')) {
      return this.doClaim(sql, params) as unknown as T[];
    }
    if (sql.includes("status = 'done'")) {
      this.doComplete(params[0] as string);
    } else if (sql.includes("status = 'pending'")) {
      this.doRetry(params[0] as string, params[1] as Date);
    } else if (sql.includes("status = 'failed'")) {
      this.doFail(params[0] as string, params[1] as string);
    } else {
      throw new Error(`不支持的 SQL：${sql}`);
    }
    return [] as T[];
  }

  private doClaim(_sql: string, params: readonly unknown[]): TaskRow[] {
    const batchSize = params[0] as number;
    const leasedUntil = params[1] as Date;
    const currentNow = params[2] as Date;
    const candidates = [...this.rows.values()]
      .filter((row) => {
        if (row.status === 'pending') {
          return row.next_run_at === null || row.next_run_at <= currentNow;
        }
        if (row.status === 'running') {
          return row.leased_until !== null && row.leased_until < currentNow;
        }
        return false;
      })
      .sort((a, b) => (a.created_at.getTime() - b.created_at.getTime()) || (a.id < b.id ? -1 : 1))
      .slice(0, batchSize);
    return candidates.map((row) => {
      const claimed: TaskRow = {
        ...row,
        status: 'running',
        leased_until: leasedUntil,
        attempts: row.attempts + 1,
      };
      this.rows.set(row.id, claimed);
      return claimed;
    });
  }

  private doComplete(id: string): void {
    const row = this.rows.get(id);
    if (row && row.status === 'running') {
      this.rows.set(id, { ...row, status: 'done', leased_until: null });
    }
  }

  private doRetry(id: string, nextRunAt: Date): void {
    const row = this.rows.get(id);
    if (row && row.status === 'running') {
      this.rows.set(id, { ...row, status: 'pending', next_run_at: nextRunAt, leased_until: null });
    }
  }

  private doFail(id: string, error: string): void {
    const row = this.rows.get(id);
    if (row && row.status === 'running') {
      this.rows.set(id, { ...row, status: 'failed', error, leased_until: null });
    }
  }
}

describe('PostgresJobTaskStore（ADR-004 租约领取/结算）', () => {
  it('claim：只领取到期 pending 任务，尝试次数 +1，返回载荷', async () => {
    const db = new FakeJobTaskDb();
    db.seed(
      task({ id: 't-due', status: 'pending', next_run_at: new Date(now.getTime() - 1_000) }),
      task({ id: 't-future', status: 'pending', next_run_at: new Date(now.getTime() + minute) }),
      task({ id: 't-done', status: 'done' }),
    );
    const store = new PostgresJobTaskStore(db);

    const claimed = await store.claim(10, now, minute);

    assert.deepEqual(claimed.map((c) => c.id), ['t-due']);
    assert.equal(claimed[0].attempts, 1);
    assert.equal(claimed[0].subjectId, 'user-1');
    assert.equal((claimed[0].payload as { field: string }).field, 'phone');
    assert.equal(db.rows.get('t-due')?.status, 'running');
    assert.equal(db.rows.get('t-future')?.status, 'pending');
  });

  it('claim：过期租约可被再次领取（至少一次执行，幂等收口）', async () => {
    const db = new FakeJobTaskDb();
    db.seed(
      task({ id: 't-expired', status: 'running', leased_until: new Date(now.getTime() - 1_000), attempts: 2 }),
      task({ id: 't-held', status: 'running', leased_until: new Date(now.getTime() + minute) }),
    );
    const store = new PostgresJobTaskStore(db);

    const claimed = await store.claim(10, now, minute);

    assert.deepEqual(claimed.map((c) => c.id), ['t-expired']);
    assert.equal(claimed[0].attempts, 3);
    assert.equal(db.rows.get('t-held')?.status, 'running');
  });

  it('claim：单笔 UPDATE 原子（RLS 平台级上下文每笔建立/清理，归还池前无残留）', async () => {
    const db = new FakeJobTaskDb();
    db.seed(task({ id: 't-1' }));
    const store = new PostgresJobTaskStore(db);

    await store.claim(10, now, minute);

    const txId = db.events[0].slice('begin:'.length);
    assert.deepEqual(db.events, [
      `begin:${txId}`,
      `set-rls:${txId}:unprotected`,
      `query:${txId}`,
      `commit:${txId}`,
      `clear-rls:${txId}`,
    ]);
  });

  it('complete/retry/fail 仅对持租约（running）任务生效', async () => {
    const db = new FakeJobTaskDb();
    const store = new PostgresJobTaskStore(db);
    const id = 't-1';
    db.seed(task({ id }));

    await store.claim(10, now, minute);
    await store.complete(id, now);
    assert.equal(db.rows.get(id)?.status, 'done');

    // 已 done 的任务再次结算不生效（WHERE status='running'）
    await store.retry(id, new Date(now.getTime() + 5_000), now);
    assert.equal(db.rows.get(id)?.status, 'done');

    db.seed(task({ id: 't-2' }));
    const claimed = await store.claim(10, now, minute);
    await store.retry('t-2', new Date(now.getTime() + 10_000), now);
    assert.equal(db.rows.get('t-2')?.status, 'pending');
    assert.equal(db.rows.get('t-2')?.attempts, claimed[0].attempts);

    db.seed(task({ id: 't-3' }));
    await store.claim(10, now, minute);
    await store.fail('t-3', 'boom', now);
    assert.equal(db.rows.get('t-3')?.status, 'failed');
    assert.equal(db.rows.get('t-3')?.error, 'boom');
  });
});

describe('computeBackoffMs（候选基线，DEP-001 复核前）', () => {
  it('指数退避：5s → 10s → 20s，封顶 1 小时', () => {
    assert.equal(computeBackoffMs(1), 5_000);
    assert.equal(computeBackoffMs(2), 10_000);
    assert.equal(computeBackoffMs(3), 20_000);
    assert.equal(computeBackoffMs(12), 3_600_000);
  });
});