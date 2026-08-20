import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TaskStatus, TaskType } from '../contracts';
import { TaskOpsEventType } from '../contracts';
import type { TaskOpsTelemetryPort, TaskRepository, TaskRecord } from '../contracts';
import { TaskScheduler } from './task-scheduler';
import { ManualInterventionService } from './manual-intervention';
import { isTaskDue, isDeadlineDue, isStaleVersion } from './deadline-policy';
import { canTransition, isClaimable } from './task-state-machine';

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    taskId: 'task-1', taskType: TaskType.FILE_CHECK, status: TaskStatus.PENDING,
    intentId: 'intent-1', idempotencyKey: 'ik:1',
    scope: { kind: 'CLUB', clubId: 'c1' },
    source: { objectType: 'f', objectId: '1', version: 1, scope: { kind: 'CLUB', clubId: 'c1' } },
    payload: {}, lease: null, attempts: 0, maxAttempts: 5, notBefore: now,
    failure: null, resultRef: null, createdAt: now, updatedAt: now, ...overrides,
  };
}

describe('deadline-policy', () => {
  it('isTaskDue past', () => {
    assert.equal(isTaskDue({ notBefore: new Date(Date.now() - 10000).toISOString() }, new Date()), true);
  });
  it('isTaskDue future', () => {
    assert.equal(isTaskDue({ notBefore: new Date(Date.now() + 60000).toISOString() }, new Date()), false);
  });
  it('isDeadlineDue past', () => {
    assert.equal(isDeadlineDue(new Date(Date.now() - 10000).toISOString(), new Date()), true);
  });
  it('isStaleVersion', () => {
    assert.equal(isStaleVersion(3, 5), true);
    assert.equal(isStaleVersion(5, 5), false);
  });
});

describe('task-state-machine', () => {
  it('PENDING -> LEASED', () => { assert.equal(canTransition(TaskStatus.PENDING, TaskStatus.LEASED), true); });
  it('RETRYABLE_FAILED -> LEASED', () => { assert.equal(canTransition(TaskStatus.RETRYABLE_FAILED, TaskStatus.LEASED), true); });
  it('LEASED -> COMPLETED', () => { assert.equal(canTransition(TaskStatus.LEASED, TaskStatus.COMPLETED), true); });
  it('LEASED -> RETRYABLE_FAILED', () => { assert.equal(canTransition(TaskStatus.LEASED, TaskStatus.RETRYABLE_FAILED), true); });
  it('LEASED -> UNCERTAIN', () => { assert.equal(canTransition(TaskStatus.LEASED, TaskStatus.UNCERTAIN), true); });
  it('MANUAL_INTERVENTION -> PENDING', () => { assert.equal(canTransition(TaskStatus.MANUAL_INTERVENTION, TaskStatus.PENDING), true); });
  it('COMPLETED -> PENDING invalid', () => { assert.equal(canTransition(TaskStatus.COMPLETED, TaskStatus.PENDING), false); });
  it('isClaimable', () => {
    assert.equal(isClaimable(TaskStatus.PENDING), true);
    assert.equal(isClaimable(TaskStatus.RETRYABLE_FAILED), true);
    assert.equal(isClaimable(TaskStatus.UNCERTAIN), true);
    assert.equal(isClaimable(TaskStatus.COMPLETED), false);
  });
});

describe('ManualInterventionService', () => {
  function makeRepo(tasks: Map<string, TaskRecord> = new Map()): TaskRepository {
    return {
      insert: async () => makeTask(), findById: async (id: string) => tasks.get(id) ?? null,
      findByIntentId: async () => null, findByIdempotencyKey: async () => null,
      tryClaim: async () => ({ claimed: true, task: makeTask() }),
      updateAfterExecution: async (_id, _ver, patch) => {
        const t = tasks.get(_id);
        if (t === undefined) return null;
        const updated = { ...t, ...patch };
        tasks.set(_id, updated);
        return updated;
      },
      listDueTaskIds: async () => [], listDeadlineTaskIds: async () => [],
      listExpiredLeaseTaskIds: async () => [],
      backlogSummary: async () => ({ pending: 0, leased: 0, retryableFailed: 0, uncertain: 0, manualIntervention: 0, completed: 0, perType: {} as Record<TaskType, number> }),
    } as TaskRepository;
  }

  it('markManualIntervention nonexistent -> null', async () => {
    const svc = new ManualInterventionService(makeRepo());
    assert.equal(await svc.markManualIntervention('x', 'r', new Date()), null);
  });
  it('markManualIntervention sets status', async () => {
    const tasks = new Map<string, TaskRecord>();
    tasks.set('task-1', makeTask({ taskId: 'task-1', status: TaskStatus.LEASED, lease: { workerId: 'w', leaseVersion: 1, leaseUntil: new Date(Date.now() + 60000).toISOString(), leasedAt: new Date().toISOString() } }));
    const svc = new ManualInterventionService(makeRepo(tasks));
    const r = await svc.markManualIntervention('task-1', 'need human', new Date());
    assert.equal(r?.status, TaskStatus.MANUAL_INTERVENTION);
    assert.equal(r?.failure?.kind, 'MANUAL_INTERVENTION_REQUIRED');
  });
  it('requeue', async () => {
    const tasks = new Map<string, TaskRecord>();
    tasks.set('task-1', makeTask({ taskId: 'task-1', status: TaskStatus.MANUAL_INTERVENTION, lease: null }));
    const svc = new ManualInterventionService(makeRepo(tasks));
    const r = await svc.requeue('task-1', new Date());
    assert.equal(r?.status, TaskStatus.PENDING);
    assert.equal(r?.lease, null);
  });
  it('close', async () => {
    const tasks = new Map<string, TaskRecord>();
    tasks.set('task-1', makeTask({ taskId: 'task-1', status: TaskStatus.MANUAL_INTERVENTION, lease: null }));
    const svc = new ManualInterventionService(makeRepo(tasks));
    const r = await svc.close('task-1', 'no longer needed', new Date());
    assert.equal(r?.status, TaskStatus.COMPLETED);
  });
});

describe('TaskScheduler', () => {
  function makeRepo(
    dueIds: string[] = [],
    expiredIds: string[] = [],
    backlogFn: () => ReturnType<TaskRepository['backlogSummary']> = async () => ({ pending: 0, leased: 0, retryableFailed: 0, uncertain: 0, manualIntervention: 0, completed: 0, perType: {} as Record<TaskType, number> }),
  ): TaskRepository {
    return {
      insert: async () => makeTask(), findById: async () => null,
      findByIntentId: async () => null, findByIdempotencyKey: async () => null,
      tryClaim: async () => ({ claimed: true, task: makeTask() }),
      updateAfterExecution: async () => makeTask(),
      listDueTaskIds: async () => dueIds, listDeadlineTaskIds: async () => [],
      listExpiredLeaseTaskIds: async () => expiredIds,
      backlogSummary: backlogFn,
    } as TaskRepository;
  }

  it('runOnce executes due tasks', async () => {
    const repo = makeRepo(['task-1', 'task-2']);
    const outbox = { register: async () => {}, forwardPending: async () => 0 };
    const executed: string[] = [];
    const pipeline = { execute: async (tid: string) => { executed.push(tid); } };
    const ops: TaskOpsTelemetryPort = { report: async () => {} };
    const scheduler = new TaskScheduler(repo, outbox as any, pipeline as any, ops);
    await scheduler.runOnce('w1', new Date(), 10);
    assert.deepEqual(executed, ['task-1', 'task-2']);
  });

  it('runOnce pipeline failure reported', async () => {
    const repo = makeRepo(['task-1']);
    const outbox = { register: async () => {}, forwardPending: async () => 0 };
    const pipeline = { execute: async () => { throw new Error('fail'); } };
    const reports: any[] = [];
    const ops: TaskOpsTelemetryPort = { report: async (e) => { reports.push(e); } };
    const scheduler = new TaskScheduler(repo, outbox as any, pipeline as any, ops);
    await scheduler.runOnce('w1', new Date(), 10);
    const failures = reports.filter((r: any) => r.event === TaskOpsEventType.TASK_EXECUTION_FAILED);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].ref, 'task-1');
  });

  it('runOnce expired lease recovery', async () => {
    const repo = makeRepo([], ['task-expired-1']);
    const outbox = { register: async () => {}, forwardPending: async () => 0 };
    const executed: string[] = [];
    const pipeline = { execute: async (tid: string) => { executed.push(tid); } };
    const reports: any[] = [];
    const ops: TaskOpsTelemetryPort = { report: async (e) => { reports.push(e); } };
    const scheduler = new TaskScheduler(repo, outbox as any, pipeline as any, ops);
    await scheduler.runOnce('w1', new Date(), 10);
    assert.deepEqual(executed, ['task-expired-1']);
    assert.ok(reports.some((r: any) => r.event === TaskOpsEventType.TASK_LEASE_RECOVERED));
  });

  it('runOnce backlog report', async () => {
    const repo = makeRepo([], [], async () => ({ pending: 5, leased: 0, retryableFailed: 2, uncertain: 1, manualIntervention: 0, completed: 10, perType: {} as Record<TaskType, number> }));
    const outbox = { register: async () => {}, forwardPending: async () => 0 };
    const pipeline = { execute: async () => {} };
    const reports: any[] = [];
    const ops: TaskOpsTelemetryPort = { report: async (e) => { reports.push(e); } };
    const scheduler = new TaskScheduler(repo, outbox as any, pipeline as any, ops);
    await scheduler.runOnce('w1', new Date(), 10);
    assert.ok(reports.some((r: any) => r.event === TaskOpsEventType.TASK_BACKLOG));
  });
});
