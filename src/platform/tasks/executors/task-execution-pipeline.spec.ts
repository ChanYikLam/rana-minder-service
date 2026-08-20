import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { RanaMinderConfig } from '../../../config';
import { TaskExecutionError, TaskStatus, TaskType } from '../contracts';
import type { TaskHandler, TaskIntent } from '../contracts';
import { TaskScopeKind } from '../contracts';
import { InMemoryTaskRepository } from '../in-memory-task-repository';
import { InMemoryIdempotencyStore } from '../idempotency/in-memory-idempotency-store';
import { RecoveryReplayConvergence } from '../idempotency/recovery-replay';
import { LeaseManager } from '../lease';
import { DevelopmentTaskPrecondition } from './task-precondition';
import { TaskExecutionPipeline } from './task-execution-pipeline';
import type { TaskProcessorRegistry } from '../contracts';

class FakeProcessorRegistry implements TaskProcessorRegistry {
  readonly handlers = new Map<TaskType, TaskHandler>();
  register(handler: TaskHandler): void {
    this.handlers.set(handler.taskType, handler);
  }
  get(taskType: TaskType): TaskHandler | undefined {
    return this.handlers.get(taskType);
  }
  list(): readonly TaskHandler[] {
    return [...this.handlers.values()];
  }
}

const fixedNow = new Date('2026-08-20T00:00:00.000Z');

function makeConfig(): RanaMinderConfig {
  return {
    job: { defaultLeaseMs: 60_000, schedulerIntervalMs: 1_000, maxAttempts: 5 },
  } as unknown as RanaMinderConfig;
}

function makeIntent(idempotencyKey: string): TaskIntent {
  return {
    intentId: `intent:${idempotencyKey}`,
    taskType: TaskType.CASDOOR_SYNC,
    idempotencyKey,
    scope: { kind: TaskScopeKind.PLATFORM },
    source: {
      objectType: 'test',
      objectId: 'o1',
      version: 1,
      scope: { kind: TaskScopeKind.PLATFORM },
    },
    payload: { externalUserId: 'cas-u1', trackingId: `tr-${idempotencyKey}` },
    notBefore: fixedNow.toISOString(),
    createdAt: fixedNow.toISOString(),
  };
}

function makeEnv() {
  const repository = new InMemoryTaskRepository();
  const idempotency = new InMemoryIdempotencyStore();
  const convergence = new RecoveryReplayConvergence(repository, idempotency);
  const registry = new FakeProcessorRegistry();
  const pipeline = new TaskExecutionPipeline(
    repository,
    new LeaseManager(repository),
    convergence,
    registry,
    new DevelopmentTaskPrecondition(),
    makeConfig(),
  );
  return { repository, registry, pipeline };
}

describe('TaskExecutionPipeline 对 TaskExecutionError 的收口', () => {
  it('handler 抛不可重试错误 → 立即 MANUAL_INTERVENTION，保留失败原因', async () => {
    const { repository, registry, pipeline } = makeEnv();
    registry.register({
      taskType: TaskType.CASDOOR_SYNC,
      handle: async () => {
        throw new TaskExecutionError('payload 不完整', false, 'MANUAL_INTERVENTION_REQUIRED');
      },
    });
    const task = await repository.insert(makeIntent('k-1'));

    await pipeline.execute(task.taskId, 'w1', fixedNow);

    const after = await repository.findById(task.taskId);
    assert.ok(after !== null);
    assert.equal(after.status, TaskStatus.MANUAL_INTERVENTION);
    assert.equal(after.attempts, 1);
    assert.equal(after.failure?.kind, 'MANUAL_INTERVENTION_REQUIRED');
    assert.match(after.failure?.reason ?? '', /payload 不完整/);
  });

  it('handler 抛可重试错误 → RETRYABLE_FAILED 且设置退避时间', async () => {
    const { repository, registry, pipeline } = makeEnv();
    registry.register({
      taskType: TaskType.CASDOOR_SYNC,
      handle: async () => {
        throw new TaskExecutionError('依赖不可用', true, 'EXTERNAL_UNCERTAIN');
      },
    });
    const task = await repository.insert(makeIntent('k-2'));

    await pipeline.execute(task.taskId, 'w1', fixedNow);

    const after = await repository.findById(task.taskId);
    assert.ok(after !== null);
    assert.equal(after.status, TaskStatus.RETRYABLE_FAILED);
    assert.equal(after.attempts, 1);
    assert.equal(after.failure?.kind, 'EXTERNAL_UNCERTAIN');
    assert.ok(after.notBefore !== null && new Date(after.notBefore).getTime() > fixedNow.getTime());
  });

  it('handler 抛普通异常且重试耗尽 → MANUAL_INTERVENTION（RETRY_LIMIT_EXCEEDED）', async () => {
    const { repository, registry, pipeline } = makeEnv();
    registry.register({
      taskType: TaskType.CASDOOR_SYNC,
      handle: async () => {
        throw new Error('boom');
      },
    });
    const task = await repository.insert(makeIntent('k-3'));
    const claimed = await repository.tryClaim(task.taskId, 'w1', 'ignored', 1, fixedNow);
    assert.ok(claimed.task !== null);
    await repository.updateAfterExecution(task.taskId, 1, { attempts: 4 });

    await pipeline.execute(task.taskId, 'w1', fixedNow);

    const after = await repository.findById(task.taskId);
    assert.ok(after !== null);
    assert.equal(after.status, TaskStatus.MANUAL_INTERVENTION);
    assert.equal(after.failure?.kind, 'RETRY_LIMIT_EXCEEDED');
  });

  it('handler 成功 → COMPLETED 并写入 resultRef', async () => {
    const { repository, registry, pipeline } = makeEnv();
    registry.register({
      taskType: TaskType.CASDOOR_SYNC,
      handle: async () => {},
    });
    const task = await repository.insert(makeIntent('k-4'));

    await pipeline.execute(task.taskId, 'w1', fixedNow);

    const after = await repository.findById(task.taskId);
    assert.ok(after !== null);
    assert.equal(after.status, TaskStatus.COMPLETED);
    assert.equal(after.attempts, 1);
    assert.ok(after.resultRef !== null && after.resultRef.startsWith(`task:${task.taskId}:completed:`));
  });
});