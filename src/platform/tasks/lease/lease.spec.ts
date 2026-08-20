import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TaskRepository, TaskRecord, TaskRecordPatch } from '../contracts';
import { TaskStatus, TaskType } from '../contracts';
import { LeaseManager } from './lease-manager';
import {
  isLeaseValid, isLeaseExpired, computeLeaseUntil,
  nextLeaseVersion, decideLease, assertLeaseVersion,
} from './lease';

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

describe('lease pure functions', () => {
  it('isLeaseValid null', () => { assert.equal(isLeaseValid(null, new Date()), false); });
  it('isLeaseValid future', () => {
    const future = new Date(Date.now() + 60000).toISOString();
    assert.equal(isLeaseValid({ workerId: 'w', leaseVersion: 1, leaseUntil: future, leasedAt: new Date().toISOString() }, new Date()), true);
  });
  it('isLeaseExpired null', () => { assert.equal(isLeaseExpired(null, new Date()), true); });
  it('computeLeaseUntil', () => {
    assert.equal(computeLeaseUntil(new Date('2025-01-01T00:00:00.000Z'), 30000), '2025-01-01T00:00:30.000Z');
  });
  it('nextLeaseVersion', () => {
    assert.equal(nextLeaseVersion(null), 1);
    assert.equal(nextLeaseVersion(3), 4);
  });
  it('decideLease', () => {
    assert.equal(decideLease(null, new Date()), 'ACQUIRED');
    const future = new Date(Date.now() + 60000).toISOString();
    assert.equal(decideLease({ workerId: 'w', leaseVersion: 1, leaseUntil: future, leasedAt: new Date().toISOString() }, new Date()), 'BUSY');
    const past = new Date(Date.now() - 1000).toISOString();
    assert.equal(decideLease({ workerId: 'w', leaseVersion: 1, leaseUntil: past, leasedAt: new Date(Date.now() - 2000).toISOString() }, new Date()), 'EXPIRED_RECOVERED');
  });
  it('assertLeaseVersion', () => {
    assert.equal(assertLeaseVersion({ workerId: 'w', leaseVersion: 5, leaseUntil: new Date().toISOString(), leasedAt: new Date().toISOString() }, 5), true);
    assert.equal(assertLeaseVersion(null, 1), false);
  });
});

describe('LeaseManager', () => {
  function makeRepo(overrides: Partial<TaskRepository> = {}): TaskRepository {
    return {
      insert: async () => makeTask(),
      findById: async () => null,
      findByIntentId: async () => null,
      findByIdempotencyKey: async () => null,
      tryClaim: async () => ({ claimed: true, task: makeTask() }),
      updateAfterExecution: async () => makeTask(),
      listDueTaskIds: async () => [],
      listDeadlineTaskIds: async () => [],
      listExpiredLeaseTaskIds: async () => [],
      backlogSummary: async () => ({ pending: 0, leased: 0, retryableFailed: 0, uncertain: 0, manualIntervention: 0, completed: 0, perType: {} as Record<TaskType, number> }),
      ...overrides,
    } as TaskRepository;
  }

  it('tryClaim NOT_FOUND', async () => {
    const mgr = new LeaseManager(makeRepo({ findById: async () => null }));
    const r = await mgr.tryClaim('task-1', 'w1', 60000, new Date());
    assert.equal(r.claimed, false);
    assert.equal(r.reason, 'NOT_FOUND');
  });
  it('tryClaim LEASE_BUSY', async () => {
    const future = new Date(Date.now() + 60000).toISOString();
    const task = makeTask({ taskId: 'task-1', status: TaskStatus.LEASED, lease: { workerId: 'w2', leaseVersion: 1, leaseUntil: future, leasedAt: new Date().toISOString() } });
    const mgr = new LeaseManager(makeRepo({ findById: async () => task }));
    const r = await mgr.tryClaim('task-1', 'w1', 60000, new Date());
    assert.equal(r.claimed, false);
    assert.equal(r.reason, 'LEASE_BUSY');
  });
  it('tryClaim success', async () => {
    const task = makeTask({ taskId: 'task-1', status: TaskStatus.PENDING, lease: null });
    const claimed = makeTask({ taskId: 'task-1', status: TaskStatus.LEASED, lease: { workerId: 'w1', leaseVersion: 1, leaseUntil: new Date(Date.now() + 60000).toISOString(), leasedAt: new Date().toISOString() } });
    const mgr = new LeaseManager(makeRepo({ findById: async () => task, tryClaim: async () => ({ claimed: true, task: claimed }) }));
    const r = await mgr.tryClaim('task-1', 'w1', 60000, new Date());
    assert.equal(r.claimed, true);
  });
  it('release valid lease', async () => {
    const future = new Date(Date.now() + 60000).toISOString();
    const task = makeTask({ taskId: 'task-1', status: TaskStatus.LEASED, lease: { workerId: 'w1', leaseVersion: 1, leaseUntil: future, leasedAt: new Date().toISOString() } });
    let called = false;
    const mgr = new LeaseManager(makeRepo({ updateAfterExecution: async () => { called = true; return makeTask({ ...task, status: TaskStatus.COMPLETED }); } }));
    await mgr.release(task, { status: TaskStatus.COMPLETED } as TaskRecordPatch, new Date());
    assert.equal(called, true);
  });
  it('release expired lease ignored', async () => {
    const past = new Date(Date.now() - 10000).toISOString();
    const task = makeTask({ taskId: 'task-1', status: TaskStatus.LEASED, lease: { workerId: 'w1', leaseVersion: 1, leaseUntil: past, leasedAt: new Date(Date.now() - 20000).toISOString() } });
    const mgr = new LeaseManager(makeRepo({ updateAfterExecution: async () => { throw new Error('should not call'); } }));
    const r = await mgr.release(task, { status: TaskStatus.COMPLETED } as TaskRecordPatch, new Date());
    assert.equal(r?.taskId, 'task-1');
  });
  it('listExpiredLeaseTaskIds delegates', async () => {
    const mgr = new LeaseManager(makeRepo({ listExpiredLeaseTaskIds: async () => ['task-1', 'task-2'] }));
    assert.deepEqual(await mgr.listExpiredLeaseTaskIds(new Date().toISOString(), 10), ['task-1', 'task-2']);
  });
});
