/**
 * TaskRepositoryJobScheduler：JobSchedulerPort → platform TaskRepository 桥接。
 * 平台仓储 taskId 为派生追踪号；组织域统一以 intentId 寻址，断言经 findByIntentId。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryTaskRepository } from '../../../platform/tasks/in-memory-task-repository';
import { TaskStatus } from '../../../platform/tasks/contracts';
import type { TaskRecord } from '../../../platform/tasks/contracts';
import { TaskRepositoryJobScheduler } from './task-repository.scheduler';

/**
 * 竞态注入桩：armed 时，findByIntentId 先把平台侧真实租约版本推进一任
 * （模拟收口窗口内被其他执行器过期重领），再向调用方返回推进前的旧快照——
 * 桥接据此以旧令牌收口，updateAfterExecution 必须返 null。
 */
class StaleReadRepo extends InMemoryTaskRepository {
  armed = false;

  override async findByIntentId(intentId: string): Promise<TaskRecord | null> {
    const record = await super.findByIntentId(intentId);
    if (record !== null && this.armed && record.lease !== null) {
      this.armed = false;
      const expiredAt = Date.parse(record.lease.leaseUntil);
      await super.tryClaim(
        record.taskId,
        'w2',
        new Date(expiredAt + 60_000).toISOString(),
        record.lease.leaseVersion + 1,
        new Date(expiredAt + 1_000),
      );
      return record; // 旧版本快照（抢占前读取）
    }
    return record;
  }
}

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

  it('complete：租约版本在收口窗口内被抢占 → 上抛而非静默吞掉', async () => {
    const repo = new StaleReadRepo();
    const scheduler = new TaskRepositoryJobScheduler(repo);
    await scheduler.enqueue(TASK);
    assert.equal(await scheduler.acquireLease(TASK.taskId, 'w1', NOW), true);
    repo.armed = true; // 读取后、收口前：版本被 w2 推进
    await assert.rejects(() => scheduler.complete(TASK.taskId), /收口未生效/);
  });

  it('complete：任务已终态 → 上抛（终态写保护不被静默绕过）', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.enqueue(TASK);
    await scheduler.acquireLease(TASK.taskId, 'w1', NOW);
    await scheduler.complete(TASK.taskId);
    // 二次 complete：任务已 COMPLETED，updateAfterExecution 返 null
    await assert.rejects(() => scheduler.complete(TASK.taskId), /收口未生效/);
  });

  it('fail：租约版本被抢占 → 上抛暴露竞争，失败结论不静默丢失', async () => {
    const repo = new StaleReadRepo();
    const scheduler = new TaskRepositoryJobScheduler(repo);
    await scheduler.enqueue(TASK);
    assert.equal(await scheduler.acquireLease(TASK.taskId, 'w1', NOW), true);
    repo.armed = true;
    await assert.rejects(() => scheduler.fail(TASK.taskId, 'casdoor 502'), /失败收口未生效/);
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

  it('listDue 多个到期任务并行取回（消除 N+1 串行往返）', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.enqueue({ ...TASK, taskId: 'tsk-1' });
    await scheduler.enqueue({ ...TASK, taskId: 'tsk-2' });
    await scheduler.enqueue({ ...TASK, taskId: 'tsk-3' });
    const due = await scheduler.listDue(NOW);
    assert.equal(due.length, 3);
    const ids = due.map((t) => t.taskId).sort();
    assert.deepEqual(ids, ['tsk-1', 'tsk-2', 'tsk-3']);
  });
});
