/**
 * JobTaskRunner 单元测试（ADR-004 结算语义）。
 *
 * 覆盖：成功完成；抛错 → 退避重试（未达上限）；达上限 → 失败保留证据；
 * 未知任务类型 → 立即失败；批量领取后逐任务结算。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JobTaskRunner } from './job-task-runner';
import type { ClaimedJobTask, JobTaskStore } from './job-task.store';

const now = new Date('2026-08-20T12:00:00.000Z');

function task(id: string, type: string, attempts = 1): ClaimedJobTask {
  return { id, type, subjectId: 'user-1', payload: {}, attempts };
}

function memoryStore(): {
  store: JobTaskStore;
  claimed: ClaimedJobTask[];
  completed: string[];
  retried: { id: string; at: Date }[];
  failed: { id: string; error: string }[];
} {
  const state = {
    claimed: [] as ClaimedJobTask[],
    completed: [] as string[],
    retried: [] as { id: string; at: Date }[],
    failed: [] as { id: string; error: string }[],
  };
  const store: JobTaskStore = {
    async claim(batchSize: number) {
      return state.claimed.splice(0, batchSize);
    },
    async complete(id: string) {
      state.completed.push(id);
    },
    async retry(id: string, nextRunAt: Date) {
      state.retried.push({ id, at: nextRunAt });
    },
    async fail(id: string, error: string) {
      state.failed.push({ id, error });
    },
    async countByStatus() {
      return { pending: 0, running: 0, done: 0, failed: 0 };
    },
    async requeue() {
      // 测试场景不依赖人工重投，置空实现
    },
  };
  return { store, ...state };
}

describe('JobTaskRunner（租约结算）', () => {
  it('成功执行 → complete', async () => {
    const { store, completed, claimed } = memoryStore();
    claimed.push(task('t-1', 'profile_sync'));
    const runner = new JobTaskRunner(
      store,
      { profile_sync: { execute: async () => {} } },
      5,
      60_000,
    );

    assert.equal(await runner.runOnce(now), 1);
    assert.deepEqual(completed, ['t-1']);
  });

  it('抛错且未达上限 → 指数退避重试（下一轮可再领取）', async () => {
    const { store, retried, claimed } = memoryStore();
    claimed.push(task('t-1', 'profile_sync', 1));
    const runner = new JobTaskRunner(
      store,
      {
        profile_sync: {
          execute: async () => {
            throw new Error('casdoor down');
          },
        },
      },
      5,
      60_000,
    );

    await runner.runOnce(now);

    assert.equal(retried.length, 1);
    assert.equal(retried[0].id, 't-1');
    assert.equal(retried[0].at.getTime(), now.getTime() + 5_000); // attempts=1 → 5s
  });

  it('达上限 → failed 保留错误证据（不再重试）', async () => {
    const { store, failed, retried, claimed } = memoryStore();
    claimed.push(task('t-1', 'profile_sync', 5));
    const runner = new JobTaskRunner(
      store,
      {
        profile_sync: {
          execute: async () => {
            throw new Error('boom');
          },
        },
      },
      5,
      60_000,
    );

    await runner.runOnce(now);

    assert.equal(failed.length, 1);
    assert.equal(failed[0].id, 't-1');
    assert.equal(failed[0].error, 'boom');
    assert.equal(retried.length, 0);
  });

  it('未知任务类型 → 立即失败（不可重试）', async () => {
    const { store, failed, claimed } = memoryStore();
    claimed.push(task('t-1', 'mystery'));
    const runner = new JobTaskRunner(store, {}, 5, 60_000);

    await runner.runOnce(now);

    assert.equal(failed.length, 1);
    assert.match(failed[0].error, /未知任务类型：mystery/);
  });

  it('批量任务逐笔结算，单笔失败不影响其余', async () => {
    const { store, completed, failed, retried, claimed } = memoryStore();
    claimed.push(task('t-1', 'good'), task('t-2', 'bad', 5), task('t-3', 'good'));
    const runner = new JobTaskRunner(
      store,
      {
        good: { execute: async () => {} },
        bad: {
          execute: async () => {
            throw new Error('boom');
          },
        },
      },
      5,
      60_000,
    );

    assert.equal(await runner.runOnce(now), 3);
    assert.deepEqual(completed, ['t-1', 't-3']);
    assert.deepEqual(
      failed.map((f) => f.id),
      ['t-2'],
    );
    assert.equal(retried.length, 0);
  });
});
