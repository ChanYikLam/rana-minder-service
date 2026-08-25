/**
 * L5 运维演练门 4：任务租约、至少一次与幂等（OPS-VER-009）。
 *
 * 锚点语义：任务租约、至少一次、旧租约拒绝和幂等——竞争、迟到提交、
 * 重复尝试和单一结果（docs/operations/部署运维与恢复手册-v1.0.md §OPS-VER 表）。
 *
 * 演练方式（真实类 + 内存仓储 + 虚拟时钟，零 sleep）：
 * - LeaseManager + InMemoryTaskRepository：双 worker 竞争互斥、租约到期重投、
 *   迟到提交按租约版本拒绝；
 * - TaskExecutionPipeline + RecoveryReplayConvergence：成功后重复执行为空操作、
 *   崩溃恢复重放收敛到单一结果。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { RanaMinderConfig } from '../../src/config';
import { TaskStatus, TaskType } from '../../src/platform/tasks/contracts';
import type { TaskHandler, TaskIntent, TaskRecord } from '../../src/platform/tasks/contracts';
import { TaskScopeKind } from '../../src/platform/tasks/contracts';
import { InMemoryTaskRepository } from '../../src/platform/tasks/in-memory-task-repository';
import { InMemoryIdempotencyStore } from '../../src/platform/tasks/idempotency/in-memory-idempotency-store';
import { RecoveryReplayConvergence } from '../../src/platform/tasks/idempotency/recovery-replay';
import { LeaseManager } from '../../src/platform/tasks/lease';
import { DevelopmentTaskPrecondition } from '../../src/platform/tasks/executors/task-precondition';
import { TaskExecutionPipeline } from '../../src/platform/tasks/executors/task-execution-pipeline';

const T0 = new Date('2026-08-24T00:00:00.000Z');
const LEASE_MS = 60_000;

/** 汇总演练证据 */
const findings = {
  mutualExclusion: false,
  atLeastOnceRedelivery: false,
  staleCommitRejected: false,
  idempotentSingleResult: false,
};

function makeIntent(idempotencyKey: string, payload: Record<string, unknown> = {}): TaskIntent {
  return {
    intentId: `intent:${idempotencyKey}`,
    taskType: TaskType.CASDOOR_SYNC,
    idempotencyKey,
    scope: { kind: TaskScopeKind.PLATFORM },
    source: {
      objectType: 'ops-drill',
      objectId: 'o-1',
      version: 1,
      scope: { kind: TaskScopeKind.PLATFORM },
    },
    payload: { externalUserId: 'cas-u1', trackingId: `tr-${idempotencyKey}`, ...payload },
    notBefore: T0.toISOString(),
    createdAt: T0.toISOString(),
  };
}

function makePipeline(
  repository: InMemoryTaskRepository,
  handler?: TaskHandler,
): { pipeline: TaskExecutionPipeline; registryHandlers: Map<TaskType, TaskHandler> } {
  const registryHandlers = new Map<TaskType, TaskHandler>();
  const registry = {
    register(h: TaskHandler): void {
      registryHandlers.set(h.taskType, h);
    },
    get(t: TaskType): TaskHandler | undefined {
      return registryHandlers.get(t);
    },
    list(): readonly TaskHandler[] {
      return [...registryHandlers.values()];
    },
  };
  if (handler) registry.register(handler);
  const pipeline = new TaskExecutionPipeline(
    repository,
    new LeaseManager(repository),
    new RecoveryReplayConvergence(new InMemoryIdempotencyStore()),
    registry,
    new DevelopmentTaskPrecondition(),
    {
      job: { defaultLeaseMs: LEASE_MS, schedulerIntervalMs: 1_000, maxAttempts: 5 },
    } as unknown as RanaMinderConfig,
  );
  return { pipeline, registryHandlers };
}

describe('OPS-VER-009 任务租约、至少一次、旧租约拒绝和幂等演练', () => {
  it('租约竞争：同一任务同一时刻双 worker 抢占，恰好一个成功', async () => {
    const repo = new InMemoryTaskRepository();
    const task = await repo.insert(makeIntent('k-race'));
    const leases = new LeaseManager(repo);

    const w1 = await leases.tryClaim(task.taskId, 'w1', LEASE_MS, T0);
    const w2 = await leases.tryClaim(task.taskId, 'w2', LEASE_MS, T0);

    assert.equal(w1.claimed, true);
    assert.equal(w1.task?.lease?.workerId, 'w1');
    assert.equal(w2.claimed, false);
    assert.equal(w2.reason, 'LEASE_BUSY');
    findings.mutualExclusion = true;
  });

  it('至少一次重投：租约到期后任务重新可领取，由另一 worker 接手', async () => {
    const repo = new InMemoryTaskRepository();
    const task = await repo.insert(makeIntent('k-redeliver'));
    const leases = new LeaseManager(repo);

    const first = await leases.tryClaim(task.taskId, 'w1', LEASE_MS, T0);
    assert.equal(first.claimed, true);

    // 未到期：不重投
    const during = await leases.tryClaim(task.taskId, 'w2', LEASE_MS, new Date(T0.getTime() + 1000));
    assert.equal(during.claimed, false);

    // 到期清单包含该任务；新 worker 在到期后成功接手（版本推进到 2）
    const expired = await leases.listExpiredLeaseTaskIds(
      new Date(T0.getTime() + LEASE_MS + 1).toISOString(),
      10,
    );
    assert.ok(expired.includes(task.taskId), '到期租约必须进入重投清单');

    const redelivered = await leases.tryClaim(
      task.taskId,
      'w2',
      LEASE_MS,
      new Date(T0.getTime() + LEASE_MS + 1),
    );
    assert.equal(redelivered.claimed, true);
    assert.equal(redelivered.task?.lease?.workerId, 'w2');
    assert.equal(redelivered.task?.lease?.leaseVersion, 2);
    findings.atLeastOnceRedelivery = true;
  });

  it('迟到提交拒绝：旧租约持有者的完成写入被忽略，不产生第二结果', async () => {
    const repo = new InMemoryTaskRepository();
    const task = await repo.insert(makeIntent('k-late'));
    const leases = new LeaseManager(repo);

    const claimA = await leases.tryClaim(task.taskId, 'wA', LEASE_MS, T0);
    const leasedA = claimA.task as TaskRecord;

    // 租约过期后 B 接手（leaseVersion=2）
    const t1 = new Date(T0.getTime() + LEASE_MS + 1);
    const claimB = await leases.tryClaim(task.taskId, 'wB', LEASE_MS, t1);
    assert.equal(claimB.claimed, true);

    // A 拿着过期租约与旧版本迟到提交 → 被 LeaseManager 忽略（返回原记录不改写）
    const late = await leases.release(
      leasedA,
      { status: TaskStatus.COMPLETED, resultRef: 'task:late-result-of-A' },
      t1,
    );
    assert.equal(late?.status, TaskStatus.LEASED, '迟到提交不得改变当前状态');
    assert.equal(late?.resultRef, null, '迟到结果不得落库');

    // 仓储层兜底：按旧租约版本的 updateAfterExecution 返回 null（写冲突）
    const staleWrite = await repo.updateAfterExecution(
      task.taskId,
      1,
      { status: TaskStatus.COMPLETED, resultRef: 'stale' },
    );
    assert.equal(staleWrite, null);
    findings.staleCommitRejected = true;
  });

  it('幂等单一结果：成功后重复执行为空操作；崩溃恢复重放收敛同一意图', async () => {
    const repo = new InMemoryTaskRepository();
    let executions = 0;
    const { pipeline } = makePipeline(repo, {
      taskType: TaskType.CASDOOR_SYNC,
      handle: async () => {
        executions += 1;
      },
    });
    const task = await repo.insert(makeIntent('k-idem'));

    // 第一次执行成功
    await pipeline.execute(task.taskId, 'w1', T0);
    const done = await repo.findById(task.taskId);
    assert.equal(done?.status, TaskStatus.COMPLETED);
    assert.equal(executions, 1);

    // 重复执行：终态直接短路，处理器不再被调用（单一结果）
    await pipeline.execute(task.taskId, 'w1', new Date(T0.getTime() + LEASE_MS + 1));
    assert.equal(executions, 1, 'COMPLETED 任务不得二次执行');

    // 崩溃恢复重放：EXECUTING 任期超时后允许重放，但成功收敛后返回原 resultRef
    const convergence = new RecoveryReplayConvergence(new InMemoryIdempotencyStore());
    const crashed = await repo.insert(makeIntent('k-crash'));
    const leases = new LeaseManager(repo);
    const claim = await leases.tryClaim(crashed.taskId, 'wX', LEASE_MS, T0);
    const begin = await convergence.convergeBeforeExecution(claim.task as TaskRecord, T0);
    assert.equal(begin.allowed, true);
    // 同一任期内的并发重入被拒绝
    const reentry = await convergence.convergeBeforeExecution(claim.task as TaskRecord, T0);
    assert.equal(reentry.allowed, false);
    // 崩溃后（任期超时）恢复重放被放行；执行成功后以原 resultRef 收敛
    const replay = await convergence.convergeBeforeExecution(
      claim.task as TaskRecord,
      new Date(T0.getTime() + LEASE_MS + 1),
    );
    assert.equal(replay.allowed, true);
    await convergence.convergeAfterSuccess(claim.task as TaskRecord, 'task:crash:resultRef');
    const afterCrash = await convergence.convergeBeforeExecution(claim.task as TaskRecord, T0);
    assert.deepEqual(afterCrash, { allowed: false, resultRef: 'task:crash:resultRef' });
    findings.idempotentSingleResult = true;
  });

  it('演练结论：互斥/至少一次/迟到拒绝/幂等单一结果 四证据齐备', () => {
    assert.deepEqual(findings, {
      mutualExclusion: true,
      atLeastOnceRedelivery: true,
      staleCommitRejected: true,
      idempotentSingleResult: true,
    });
  });
});
