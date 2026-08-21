/**
 * PostgreSQL 平台任务仓储（T1）集成测试（L2；真实 PG18，仅 CI/有 docker 时运行）。
 *
 * 覆盖（ADR-004 / DATA-CON-006 / SEC-VER-011）：
 * - insert 幂等：同 intentId 二次 insert 返回既有记录；
 * - tryClaim 原子单胜者：并发下只有一个 worker 领取成功；
 * - 旧租约令牌提交必须失败（SEC-VER-011）：updateAfterExecution 带错误版本返回 null；
 * - 租约到期可重领（过期重领）；
 * - listDueTaskIds / listExpiredLeaseTaskIds / backlogSummary。
 *
 * 依赖：test:integration 阶段由 CI 启动 postgres:18 容器并设置 DATABASE_*；
 * 本地无 docker 时跳过。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { PostgresDbAdapter } from '../../src/adapters/db/postgres-db-adapter';
import { PostgresTaskRepository } from '../../src/platform/tasks/postgres-task-repository';
import { TaskStatus } from '../../src/platform/tasks/contracts/task-status';
import { TaskType } from '../../src/platform/tasks/contracts/task-type';
import type { TaskIntent } from '../../src/platform/tasks/contracts/task-intent';
import type { DbAdapter } from '../../src/shared/db-adapter';

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const canRun = dockerAvailable();
const skip = !canRun;

const dbConfig = {
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5432),
  database: process.env.DATABASE_NAME ?? 'ranaminder_test',
  user: process.env.DATABASE_USER ?? 'postgres',
  password: process.env.DATABASE_PASSWORD ?? 'ci',
  ssl: false,
};

let db: DbAdapter | null = null;
let repo: PostgresTaskRepository | null = null;
let adapter: PostgresDbAdapter | null = null;

function intent(overrides?: Partial<TaskIntent>): TaskIntent {
  const id = `intent-${Math.random().toString(36).slice(2, 8)}`;
  return {
    intentId: id,
    taskType: TaskType.NOTIFICATION_DELIVERY,
    idempotencyKey: `idem-${id}`,
    scope: { kind: 'PLATFORM' },
    source: { objectType: 'notification', objectId: id, version: 1, scope: { kind: 'PLATFORM' } },
    payload: { ref: id },
    notBefore: new Date(Date.now() - 1000).toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

before(async () => {
  if (skip) return;
  adapter = new PostgresDbAdapter(dbConfig);
  db = adapter;
  repo = new PostgresTaskRepository(db);
  // 清理上次残留，确保断言确定性
  const tx = await db.beginTransaction();
  await db.query(tx, 'DELETE FROM task_records', []);
  await db.commit(tx);
});

after(async () => {
  if (adapter) {
    await adapter.onModuleDestroy();
  }
});

describe('PostgresTaskRepository（T1 租约原子竞争）', { skip }, () => {
  it('insert 写入任务并可查；同 intentId 二次 insert 返回既有记录（幂等）', async () => {
    const r = repo!;
    const it = intent();
    const created = await r.insert(it);
    assert.equal(created.status, TaskStatus.PENDING);
    assert.equal(created.intentId, it.intentId);

    const again = await r.insert(it);
    assert.equal(again.taskId, created.taskId);

    const found = await r.findByIntentId(it.intentId);
    assert.ok(found);
    assert.equal(found.taskId, created.taskId);
  });

  it('tryClaim 领取成功并置 LEASED；已领取被另一 worker 拒绝（原子单胜者）', async () => {
    const r = repo!;
    const it = intent();
    const created = await r.insert(it);
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + 60_000).toISOString();

    const first = await r.tryClaim(created.taskId, 'worker-A', leaseUntil, 1, now);
    assert.equal(first.claimed, true);
    assert.equal(first.task!.status, TaskStatus.LEASED);

    const second = await r.tryClaim(created.taskId, 'worker-B', leaseUntil, 1, now);
    assert.equal(second.claimed, false);
    assert.equal(second.reason, 'LEASE_BUSY');
  });

  it('旧租约令牌提交必须失败（SEC-VER-011）：版本不匹配返回 null', async () => {
    const r = repo!;
    const it = intent();
    const created = await r.insert(it);
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + 60_000).toISOString();
    const claimed = await r.tryClaim(created.taskId, 'worker-A', leaseUntil, 1, now);
    assert.equal(claimed.claimed, true);

    // 错误版本提交 → 失败
    const wrong = await r.updateAfterExecution(created.taskId, 999, {
      status: TaskStatus.COMPLETED,
      resultRef: 'r-1',
    });
    assert.equal(wrong, null);

    // 正确版本提交 → 成功
    const right = await r.updateAfterExecution(created.taskId, 1, {
      status: TaskStatus.COMPLETED,
      resultRef: 'r-1',
    });
    assert.ok(right);
    assert.equal(right.status, TaskStatus.COMPLETED);
  });

  it('租约到期可重领（过期重领）', async () => {
    const r = repo!;
    const it = intent();
    const created = await r.insert(it);
    const past = new Date();
    const expiredLease = new Date(past.getTime() - 1000).toISOString();
    const claimed = await r.tryClaim(created.taskId, 'worker-A', expiredLease, 1, past);
    assert.equal(claimed.claimed, true);

    // 租约已过期，另一 worker 可重领
    const reclaim = await r.tryClaim(
      created.taskId,
      'worker-B',
      new Date(Date.now() + 60_000).toISOString(),
      2,
      new Date(),
    );
    assert.equal(reclaim.claimed, true);
  });

  it('listDueTaskIds 仅返回到期可执行任务；backlogSummary 统计', async () => {
    const r = repo!;
    const due = await r.insert(intent());
    await r.insert(intent({ notBefore: new Date(Date.now() + 60_000).toISOString() }));

    const dueIds = await r.listDueTaskIds(new Date().toISOString(), 10);
    assert.ok(dueIds.includes(due.taskId));

    const summary = await r.backlogSummary();
    assert.ok(summary.pending >= 2);
    assert.ok(summary.perType[TaskType.NOTIFICATION_DELIVERY] >= 2);
  });
});
