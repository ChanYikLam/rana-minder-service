/**
 * 集成测试 L2：PostgreSQL 后台任务表 + 租约原子竞争更新（T1）。
 *
 * 权威依据：DATA-CON-006（领取原子跳过有效租约）、SEC-VER-011（旧租约令牌提交必须失败）、
 * ADR-004（至少一次执行）、DATA-JOB-001（通用任务执行信封）。
 *
 * 运行方式：需真实 PG18（CI 的 .cnb.yml 阶段 5 启动 pg18-ci 容器）；
 * 本地无 docker/PG 时跳过（与 test/integration/pg18.spec.ts 口径一致）。
 *
 * 覆盖：
 * - 迁移 up/down 幂等可重入（job_tasks 表结构与约束）
 * - insert 按 intent_id 幂等去重
 * - 并发双 worker 原子领取：只有一方单胜者（SKIP LOCKED / 条件 UPDATE 语义）
 * - updateAfterExecution 旧租约令牌拒绝（SEC-VER-011）
 * - 租约过期可重领
 * - backlogSummary 分状态/分类型统计
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import pg from 'pg';

import { PostgresTaskRepository } from '../../src/platform/tasks/infrastructure/postgres-task-repository';
import {
  up as jobTasksUp,
  down as jobTasksDown,
} from '../../src/database/migrations/20260822120000_create-job-task-tables';
import type { DbAdapter, RlsScope, TransactionContext } from '../../src/shared/db-adapter';
import { TaskStatus } from '../../src/platform/tasks/contracts/task-status';
import { TaskType } from '../../src/platform/tasks/contracts/task-type';
import type { TaskIntent } from '../../src/platform/tasks/contracts/task-intent';

const CI = process.env.CI === 'true';
const DB_NAME = process.env.PGTEST_DB ?? 'ranaminder_test';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const canRun = dockerAvailable();
const skipFlag = !canRun && !CI ? '本地未检测到 docker，跳过 PG18 任务表集成测试' : false;

interface TestTx extends TransactionContext {
  client: pg.PoolClient;
}

/** 最小测试 DbAdapter：基于 pg Pool 实现事务/RLS 桩/查询，供仓储在真实 PG 上验证 */
class TestDbAdapter implements DbAdapter {
  constructor(private readonly pool: pg.Pool) {}

  async beginTransaction(): Promise<TestTx> {
    const client = await this.pool.connect();
    await client.query('BEGIN');
    return { id: `tx:${Math.random()}`, client };
  }

  async commit(tx: TransactionContext): Promise<void> {
    const t = tx as TestTx;
    await t.client.query('COMMIT');
    t.client.release();
  }

  async rollback(tx: TransactionContext): Promise<void> {
    const t = tx as TestTx;
    await t.client.query('ROLLBACK').catch(() => undefined);
    t.client.release();
  }

  async setRlsContext(_tx: TransactionContext, _scope: RlsScope): Promise<void> {
    // 后台任务属技术运行域，不适用普通社团 RLS（ADR-005）
  }

  async clearRlsContext(_tx: TransactionContext): Promise<void> {
    // no-op
  }

  async query<T>(tx: TransactionContext, sql: string, params: readonly unknown[]): Promise<T[]> {
    const t = tx as TestTx;
    const res = await t.client.query(sql, params as unknown[]);
    return res.rows as T[];
  }
}

let pool: pg.Pool;
let adapter: TestDbAdapter;
let repo: PostgresTaskRepository;

function makeIntent(overrides: Partial<TaskIntent> = {}): TaskIntent {
  const now = new Date().toISOString();
  return {
    intentId: `intent-${Math.random().toString(36).slice(2)}`,
    taskType: TaskType.FILE_CHECK,
    idempotencyKey: `ik:${Math.random().toString(36).slice(2)}`,
    scope: { kind: 'CLUB', clubId: 'c1' },
    source: { objectType: 'f', objectId: '1', version: 1, scope: { kind: 'CLUB', clubId: 'c1' } },
    payload: {},
    notBefore: now,
    createdAt: now,
    ...overrides,
  };
}

before(async () => {
  if (!canRun) {
    if (CI) throw new Error('CI=true 但 docker 不可用，无法执行 PG18 任务表集成测试');
    return;
  }
  pool = new pg.Pool({
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: 'ci',
    database: DB_NAME,
  });
  adapter = new TestDbAdapter(pool);
  repo = new PostgresTaskRepository(adapter as unknown as DbAdapter);

  const runner = {
    query: async (sql: string): Promise<unknown> => pool.query(sql),
  };
  await jobTasksDown(runner);
  await jobTasksUp(runner);
});

after(async () => {
  if (pool) await pool.end();
});

test('迁移：job_tasks 表结构可用且 up 可重入幂等', { skip: skipFlag }, async () => {
  if (!pool) return;
  const res = await pool.query(`SELECT to_regclass('public.job_tasks') AS cls`);
  assert.notEqual(res.rows[0].cls, null);
  // 再次 up 幂等不报错
  const runner = { query: async (sql: string): Promise<unknown> => pool.query(sql) };
  await jobTasksUp(runner);
});

test('insert 创建 PENDING 任务且按 intent_id 幂等', { skip: skipFlag }, async () => {
  if (!repo) return;
  const intent = makeIntent();
  const t1 = await repo.insert(intent);
  assert.equal(t1.status, TaskStatus.PENDING);
  assert.equal(t1.maxAttempts, 5);
  const t2 = await repo.insert({ ...intent });
  assert.equal(t2.taskId, t1.taskId);
});

test('并发双 worker 原子领取：单胜者（租约原子竞争更新）', { skip: skipFlag }, async () => {
  if (!repo) return;
  const intent = makeIntent({ notBefore: new Date(Date.now() - 1000).toISOString() });
  const task = await repo.insert(intent);
  const leaseUntil = new Date(Date.now() + 60000).toISOString();

  const results = await Promise.all([
    repo.tryClaim(task.taskId, 'worker-a', leaseUntil, 1, new Date()),
    repo.tryClaim(task.taskId, 'worker-b', leaseUntil, 1, new Date()),
  ]);

  const claimed = results.filter((r) => r.claimed === true);
  const rejected = results.filter((r) => r.claimed === false);
  assert.equal(claimed.length, 1, '两个并发领取必须只有一个单胜者');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'LEASE_BUSY');
  // 胜者持有的 worker 必须是参与竞争的两个 worker 之一；败者结果中的 task 为被持行态快照
  assert.ok(
    claimed[0].task?.lease?.workerId === 'worker-a' ||
      claimed[0].task?.lease?.workerId === 'worker-b',
  );
  assert.equal(rejected[0].task?.lease?.workerId, claimed[0].task?.lease?.workerId);
});

test(
  'updateAfterExecution：旧租约令牌提交必须失败（SEC-VER-011）',
  { skip: skipFlag },
  async () => {
    if (!repo) return;
    const intent = makeIntent({ notBefore: new Date(Date.now() - 1000).toISOString() });
    const task = await repo.insert(intent);
    const leaseUntil = new Date(Date.now() + 60000).toISOString();
    const claim = await repo.tryClaim(task.taskId, 'worker-a', leaseUntil, 1, new Date());
    assert.equal(claim.claimed, true);
    // 旧租约版本（0 或错误版本）提交必须失败
    const stale = await repo.updateAfterExecution(task.taskId, 0, {
      status: TaskStatus.COMPLETED,
    });
    assert.equal(stale, null);
    const wrong = await repo.updateAfterExecution(task.taskId, 99, {
      status: TaskStatus.COMPLETED,
    });
    assert.equal(wrong, null);
    // 正确租约版本提交成功
    const ok = await repo.updateAfterExecution(task.taskId, 1, {
      status: TaskStatus.COMPLETED,
    });
    assert.equal(ok?.status, TaskStatus.COMPLETED);
    // 终态不可再被改写
    const again = await repo.updateAfterExecution(task.taskId, 1, {
      status: TaskStatus.PENDING,
    });
    assert.equal(again, null);
  },
);

test('租约过期可重领（SEC-VER-011 过期重领）', { skip: skipFlag }, async () => {
  if (!repo) return;
  const intent = makeIntent({ notBefore: new Date(Date.now() - 1000).toISOString() });
  const task = await repo.insert(intent);
  // 第一次领取，租约极短立即过期
  const past = new Date(Date.now() - 10).toISOString();
  const first = await repo.tryClaim(task.taskId, 'worker-a', past, 1, new Date());
  assert.equal(first.claimed, true);
  // 租约已过期，另一 worker 可重领（新租约版本）
  const future = new Date(Date.now() + 60000).toISOString();
  const second = await repo.tryClaim(task.taskId, 'worker-b', future, 2, new Date());
  assert.equal(second.claimed, true);
  assert.equal(second.task?.lease?.workerId, 'worker-b');
  assert.equal(second.task?.lease?.leaseVersion, 2);
});

test('backlogSummary 分状态/分类型统计', { skip: skipFlag }, async () => {
  if (!repo) return;
  const pendingIntent = makeIntent({ taskType: TaskType.FILE_CHECK });
  await repo.insert(pendingIntent);
  const doneIntent = makeIntent({ taskType: TaskType.NOTIFICATION_DELIVERY });
  const done = await repo.insert(doneIntent);
  const leaseUntil = new Date(Date.now() + 60000).toISOString();
  await repo.tryClaim(done.taskId, 'w1', leaseUntil, 1, new Date());
  await repo.updateAfterExecution(done.taskId, 1, { status: TaskStatus.COMPLETED });

  const summary = await repo.backlogSummary();
  assert.ok(summary.pending >= 1);
  assert.ok(summary.completed >= 1);
  assert.ok(summary.perType[TaskType.FILE_CHECK] >= 1);
  assert.ok(summary.perType[TaskType.NOTIFICATION_DELIVERY] >= 1);
});
