/**
 * TaskRepositoryJobScheduler：JobSchedulerPort → platform TaskRepository 桥接。
 * 平台仓储 taskId 为派生追踪号；组织域统一以 intentId 寻址，断言经 findByIntentId。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryTaskRepository } from '../../../platform/tasks/in-memory-task-repository';
import { TaskStatus } from '../../../platform/tasks/contracts';
import { TaskRepositoryJobScheduler } from './task-repository.scheduler';

function makeScheduler(): {
  scheduler: TaskRepositoryJobScheduler;
  repo: InMemoryTaskRepository;
} {
  const repo = new InMemoryTaskRepository();
  return { scheduler: new TaskRepositoryJobScheduler(repo), repo };
}

const TASK = {
  taskId: 'tsk-rel-1',
  kind: 'relation_execute' as const,
  refId: 'relcmd-1',
  scheduleType: 'immediate' as const,
  at: null,
  idempotencyKey: 'relation-exec:relcmd-1',
  leaseHolder: null,
};

const NOW = new Date('2026-08-01T00:00:00.000Z');

describe('TaskRepositoryJobScheduler（ADR-004 持久任务桥接）', () => {
  it('enqueue 幂等：同一 taskId 重复登记只产生一条任务', async () => {
    const { scheduler, repo } = makeScheduler();
    await scheduler.enqueue(TASK);
    await scheduler.enqueue(TASK);
    const record = await repo.findByIntentId(TASK.taskId);
    assert.ok(record);
    assert.equal(record.taskType, 'CASDOOR_GROUP_WRITE');
    assert.equal((await scheduler.listDue(NOW)).length, 1);
  });

  it('acquireLease 单执行租约：租约窗口内任何持有者（含原持有者）都拿不到', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.enqueue(TASK);
    assert.equal(await scheduler.acquireLease(TASK.taskId, 'w1', NOW), true);
    // 平台单执行租约语义（CAS-WR-011）：租约未过期前一律互斥，不区分是否同一持有者
    assert.equal(await scheduler.acquireLease(TASK.taskId, 'w2', NOW), false);
    assert.equal(await scheduler.acquireLease(TASK.taskId, 'w1', NOW), false);
    // 租约过期后可被其他 worker 认领
    const afterLease = new Date(NOW.getTime() + 61_000);
    assert.equal(await scheduler.acquireLease(TASK.taskId, 'w2', afterLease), true);
  });

  it('complete 后不再出现在到期列表', async () => {
    const { scheduler, repo } = makeScheduler();
    await scheduler.enqueue(TASK);
    await scheduler.acquireLease(TASK.taskId, 'w1', NOW);
    await scheduler.complete(TASK.taskId);
    const record = (await repo.findByIntentId(TASK.taskId))!;
    assert.equal(record.status, TaskStatus.COMPLETED);
    assert.equal((await scheduler.listDue(NOW)).length, 0);
  });

  it('fail 释放租约并置可重试失败', async () => {
    const { scheduler, repo } = makeScheduler();
    await scheduler.enqueue(TASK);
    await scheduler.acquireLease(TASK.taskId, 'w1', NOW);
    await scheduler.fail(TASK.taskId, 'casdoor 502');
    const record = (await repo.findByIntentId(TASK.taskId))!;
    assert.equal(record.status, TaskStatus.RETRYABLE_FAILED);
    assert.equal(record.lease, null);
  });

  it('listDue 映射回 ScheduledTask（refId/kind/at）', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.enqueue({ ...TASK, scheduleType: 'at', at: NOW.toISOString() });
    const due = await scheduler.listDue(new Date(NOW.getTime() + 60_000));
    assert.equal(due.length, 1);
    assert.equal(due[0].taskId, TASK.taskId); // 组织域以 intentId 寻址，与 acquireLease/complete/fail 一致
    assert.equal(due[0].refId, 'relcmd-1');
    assert.equal(due[0].kind, 'relation_execute');
    assert.equal(due[0].scheduleType, 'at');
  });
});
