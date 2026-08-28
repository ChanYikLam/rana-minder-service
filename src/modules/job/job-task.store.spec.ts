/**
 * PostgresJobTaskStore 单元测试（ADR-004 租约执行语义）。
 *
 * 用仿真 DbAdapter（按 job_tasks 真实表语义执行 claim/complete/retry/fail SQL：
 * task_id/task_type/status 大写枚举/not_before/lease_until，见迁移 20260820130000）
 * 验证：领取只取到期/过期租约任务、单笔 UPDATE 原子、尝试次数递增、
 * 租约过期可重新领取、结算仅限持租约者、RLS 平台级上下文每笔建立并清理。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresJobTaskStore, computeBackoffMs } from './job-task.store';
import type { DbAdapter, RlsScope, TransactionContext } from '../../shared/db-adapter';

type TaskStatus = 'PENDING' | 'LEASED' | 'COMPLETED' | 'RETRYABLE_FAILED' | 'MANUAL_INTERVENTION';

interface TaskRow {
  task_id: string;
  task_type: string;
  payload: Record<string, unknown>;
  status: TaskStatus;
  attempts: number;
  not_before: Date | null;
  lease_until: Date | null;
  created_at: Date;
}

const now = new Date('2026-08-20T12:00:00.000Z');
const minute = 60_000;

function task(overrides?: Partial<TaskRow>): TaskRow {
  return {
    task_id: 'CASDOOR_SYNC:user-1:phone:4',
    task_type: 'CASDOOR_SYNC',
    payload: {
      subjectId: 'user-1',
      field: 'phone',
      targetVersion: 4,
      intentId: 'intent-1',
    },
    status: 'PENDING',
    attempts: 0,
    not_before: null,
    lease_until: null,
    created_at: now,
    ...overrides,
  };
}

class FakeJobTaskDb implements DbAdapter {
  rows = new Map<string, TaskRow>();
  readonly events: string[] = [];
  readonly queries: { sql: string; params: readonly unknown[] }[] = [];
  private txCounter = 0;

  seed(...rows: TaskRow[]): void {
    for (const row of rows) {
      this.rows.set(row.task_id, row);
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
    this.queries.push({ sql, params });
    if (sql.includes('RETURNING t.task_id, t.task_type')) {
      return this.doClaim(params) as unknown as T[];
    }
    if (sql.includes("status = 'COMPLETED'")) {
      this.doComplete(params[0] as string);
    } else if (sql.includes("status = 'RETRYABLE_FAILED'")) {
      this.doRetry(params[0] as string, params[1] as Date);
    } else if (sql.includes("status = 'MANUAL_INTERVENTION'")) {
      this.doFail(params[0] as string);
    } else if (sql.includes("status = 'PENDING'") && sql.includes('requeue-sentinel')) {
      // 预留：requeue 语义由集成覆盖
    } else {
      throw new Error(`不支持的 SQL：${sql}`);
    }
    return [] as T[];
  }

  private doClaim(params: readonly unknown[]): TaskRow[] {
    const batchSize = params[0] as number;
    const leaseUntil = params[1] as Date;
    const currentNow = params[2] as Date;
    const candidates = [...this.rows.values()]
      .filter((row) => {
        if (row.status === 'PENDING') {
          return row.not_before === null || row.not_before <= currentNow;
        }
        if (row.status === 'LEASED') {
          return row.lease_until !== null && row.lease_until < currentNow;
        }
        return false;
      })
      .sort(
        (a, b) => a.created_at.getTime() - b.created_at.getTime() || (a.task_id < b.task_id ? -1 : 1),
      )
      .slice(0, batchSize);
    return candidates.map((row) => {
      const claimed: TaskRow = {
        ...row,
        status: 'LEASED',
        lease_until: leaseUntil,
        attempts: row.attempts + 1,
      };
      this.rows.set(row.task_id, claimed);
      return claimed;
    });
  }

  private doComplete(id: string): void {
    const row = this.rows.get(id);
    if (row && row.status === 'LEASED') {
      this.rows.set(id, { ...row, status: 'COMPLETED', lease_until: null });
    }
  }

  private doRetry(id: string, notBefore: Date): void {
    const row = this.rows.get(id);
    if (row && row.status === 'LEASED') {
      this.rows.set(id, { ...row, status: 'RETRYABLE_FAILED', not_before: notBefore, lease_until: null });
    }
  }

  private doFail(id: string): void {
    const row = this.rows.get(id);
    if (row && row.status === 'LEASED') {
      this.rows.set(id, { ...row, status: 'MANUAL_INTERVENTION', lease_until: null });
    }
  }
}

describe('PostgresJobTaskStore（ADR-004 租约领取/结算，真实表结构）', () => {
  it('SQL 占位符全部有对应参数（真实 PostgreSQL 占位符序须与参数数组一致）', async () => {
    const db = new FakeJobTaskDb();
    db.seed(task({ task_id: 't-1' }));
    const store = new PostgresJobTaskStore(db);

    await store.claim(10, now, minute);
    await store.complete('t-1', now);
    db.seed(task({ task_id: 't-2' }));
    await store.claim(10, now, minute);
    await store.retry('t-2', new Date(now.getTime() + 5_000), now);
    db.seed(task({ task_id: 't-3' }));
    await store.claim(10, now, minute);
    await store.fail('t-3', 'boom', now);

    assert.ok(db.queries.length > 0);
    for (const { sql, params } of db.queries) {
      const maxIndex = [...sql.matchAll(/\$(\d+)/g)].reduce(
        (max, match) => Math.max(max, Number(match[1])),
        0,
      );
      assert.ok(
        maxIndex <= params.length,
        `SQL 引用 $${maxIndex} 但参数仅 ${params.length} 个：${sql}`,
      );
    }
  });

  it('claim：只领取到期 PENDING 任务，尝试次数 +1，返回载荷', async () => {
    const db = new FakeJobTaskDb();
    db.seed(
      task({ task_id: 't-due', status: 'PENDING', not_before: new Date(now.getTime() - 1_000) }),
      task({ task_id: 't-future', status: 'PENDING', not_before: new Date(now.getTime() + minute) }),
      task({ task_id: 't-done', status: 'COMPLETED' }),
    );
    const store = new PostgresJobTaskStore(db);

    const claimed = await store.claim(10, now, minute);

    assert.deepEqual(
      claimed.map((c) => c.id),
      ['t-due'],
    );
    assert.equal(claimed[0].attempts, 1);
    assert.equal(claimed[0].subjectId, 'user-1');
    assert.equal((claimed[0].payload as { field: string }).field, 'phone');
    assert.equal(db.rows.get('t-due')?.status, 'LEASED');
    assert.equal(db.rows.get('t-future')?.status, 'PENDING');
  });

  it('claim：过期租约可被再次领取（至少一次执行，幂等收口）', async () => {
    const db = new FakeJobTaskDb();
    db.seed(
      task({
        task_id: 't-expired',
        status: 'LEASED',
        lease_until: new Date(now.getTime() - 1_000),
        attempts: 2,
      }),
      task({ task_id: 't-held', status: 'LEASED', lease_until: new Date(now.getTime() + minute) }),
    );
    const store = new PostgresJobTaskStore(db);

    const claimed = await store.claim(10, now, minute);

    assert.deepEqual(
      claimed.map((c) => c.id),
      ['t-expired'],
    );
    assert.equal(claimed[0].attempts, 3);
    assert.equal(db.rows.get('t-held')?.status, 'LEASED');
  });

  it('claim：单笔 UPDATE 原子（RLS 平台级上下文每笔建立/清理，归还池前无残留）', async () => {
    const db = new FakeJobTaskDb();
    db.seed(task({ task_id: 't-1' }));
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

  it('claim：payload 损坏时整体回滚，不留下已提交但不可用的 LEASED 任务', async () => {
    const db = new FakeJobTaskDb();
    db.seed(task({ task_id: 't-bad', payload: '{not-json' as unknown as Record<string, unknown> }));
    const store = new PostgresJobTaskStore(db);

    // payload 非法 JSON，claim 必须抛出而非返回，且事务走回滚（不 commit）
    await assert.rejects(() => store.claim(10, now, minute), /JSON/);

    const txId = db.events[0].slice('begin:'.length);
    assert.deepEqual(db.events, [
      `begin:${txId}`,
      `set-rls:${txId}:unprotected`,
      `query:${txId}`,
      `rollback:${txId}`,
      `clear-rls:${txId}`,
    ]);
  });

  it('complete/retry/fail 仅对持租约（LEASED）任务生效', async () => {
    const db = new FakeJobTaskDb();
    const store = new PostgresJobTaskStore(db);
    const id = 't-1';
    db.seed(task({ task_id: id }));

    await store.claim(10, now, minute);
    await store.complete(id, now);
    assert.equal(db.rows.get(id)?.status, 'COMPLETED');

    // 已 COMPLETED 的任务再次结算不生效（WHERE status='LEASED'）
    await store.retry(id, new Date(now.getTime() + 5_000), now);
    assert.equal(db.rows.get(id)?.status, 'COMPLETED');

    db.seed(task({ task_id: 't-2' }));
    const claimed = await store.claim(10, now, minute);
    await store.retry('t-2', new Date(now.getTime() + 10_000), now);
    assert.equal(db.rows.get('t-2')?.status, 'RETRYABLE_FAILED');
    assert.equal(db.rows.get('t-2')?.attempts, claimed[0].attempts);

    db.seed(task({ task_id: 't-3' }));
    await store.claim(10, now, minute);
    await store.fail('t-3', 'boom', now);
    assert.equal(db.rows.get('t-3')?.status, 'MANUAL_INTERVENTION');
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
