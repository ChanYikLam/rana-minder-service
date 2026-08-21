import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryTaskRepository } from './in-memory-task-repository';
import { TaskStatus } from './contracts/task-status';
import { TaskType } from './contracts/task-type';
import { deriveTrackingNumber } from './contracts/task-intent';
import type { TaskIntent } from './contracts';

function makeIntent(overrides: Partial<TaskIntent> = {}): TaskIntent {
  const now = new Date().toISOString();
  return {
    intentId: 'intent-1',
    taskType: TaskType.FILE_CHECK,
    idempotencyKey: 'ik:1',
    scope: { kind: 'CLUB', clubId: 'c1' },
    source: { objectType: 'f', objectId: '1', version: 1, scope: { kind: 'CLUB', clubId: 'c1' } },
    payload: {},
    notBefore: now,
    createdAt: now,
    ...overrides,
  };
}

describe('InMemoryTaskRepository', () => {
  it('insert creates PENDING task', async () => {
    const repo = new InMemoryTaskRepository();
    const task = await repo.insert(
      makeIntent({ intentId: 'intent-1', taskType: TaskType.FILE_CHECK }),
    );
    assert.equal(task.status, TaskStatus.PENDING);
    assert.equal(task.intentId, 'intent-1');
    assert.equal(task.taskId, deriveTrackingNumber('intent-1', TaskType.FILE_CHECK));
  });

  it('insert same intentId idempotent', async () => {
    const repo = new InMemoryTaskRepository();
    const t1 = await repo.insert(makeIntent({ intentId: 'intent-1' }));
    const t2 = await repo.insert(makeIntent({ intentId: 'intent-1' }));
    assert.equal(t1.taskId, t2.taskId);
  });

  it('findById found/not found', async () => {
    const repo = new InMemoryTaskRepository();
    const inserted = await repo.insert(makeIntent({ intentId: 'intent-1' }));
    assert.equal((await repo.findById(inserted.taskId))?.taskId, inserted.taskId);
    assert.equal(await repo.findById('nonexistent'), null);
  });

  it('findByIntentId', async () => {
    const repo = new InMemoryTaskRepository();
    await repo.insert(makeIntent({ intentId: 'intent-1' }));
    assert.equal((await repo.findByIntentId('intent-1'))?.intentId, 'intent-1');
    assert.equal(await repo.findByIntentId('nonexistent'), null);
  });

  it('findByIdempotencyKey', async () => {
    const repo = new InMemoryTaskRepository();
    await repo.insert(makeIntent({ idempotencyKey: 'ik:unique' }));
    assert.equal((await repo.findByIdempotencyKey('ik:unique'))?.idempotencyKey, 'ik:unique');
    assert.equal(await repo.findByIdempotencyKey('x'), null);
  });

  it('tryClaim NOT_FOUND', async () => {
    const repo = new InMemoryTaskRepository();
    const r = await repo.tryClaim('x', 'w1', new Date().toISOString(), 1, new Date());
    assert.equal(r.claimed, false);
    assert.equal(r.reason, 'NOT_FOUND');
  });

  it('tryClaim COMPLETED returns TERMINAL', async () => {
    const repo = new InMemoryTaskRepository();
    const t = await repo.insert(makeIntent({ intentId: 'i1' }));
    await repo.updateAfterExecution(t.taskId, 0, { status: TaskStatus.COMPLETED });
    const r = await repo.tryClaim(t.taskId, 'w1', new Date().toISOString(), 1, new Date());
    assert.equal(r.claimed, false);
    assert.equal(r.reason, 'TERMINAL');
  });

  it('tryClaim LEASE_BUSY', async () => {
    const repo = new InMemoryTaskRepository();
    const t = await repo.insert(makeIntent({ intentId: 'i1' }));
    const future = new Date(Date.now() + 60000).toISOString();
    await repo.tryClaim(t.taskId, 'w2', future, 1, new Date());
    const r = await repo.tryClaim(t.taskId, 'w1', future, 2, new Date());
    assert.equal(r.claimed, false);
    assert.equal(r.reason, 'LEASE_BUSY');
  });

  it('tryClaim PENDING success', async () => {
    const repo = new InMemoryTaskRepository();
    const t = await repo.insert(makeIntent({ intentId: 'i1' }));
    const future = new Date(Date.now() + 60000).toISOString();
    const r = await repo.tryClaim(t.taskId, 'w1', future, 1, new Date());
    assert.equal(r.claimed, true);
    assert.equal(r.task?.status, TaskStatus.LEASED);
    assert.equal(r.task?.lease?.workerId, 'w1');
  });

  it('updateAfterExecution terminal rejected', async () => {
    const repo = new InMemoryTaskRepository();
    const t = await repo.insert(makeIntent({ intentId: 'i1' }));
    await repo.updateAfterExecution(t.taskId, 0, { status: TaskStatus.COMPLETED });
    assert.equal(
      await repo.updateAfterExecution(t.taskId, 0, { status: TaskStatus.PENDING }),
      null,
    );
  });

  it('updateAfterExecution version mismatch null', async () => {
    const repo = new InMemoryTaskRepository();
    const t = await repo.insert(makeIntent({ intentId: 'i1' }));
    const future = new Date(Date.now() + 60000).toISOString();
    await repo.tryClaim(t.taskId, 'w1', future, 1, new Date());
    assert.equal(
      await repo.updateAfterExecution(t.taskId, 999, { status: TaskStatus.COMPLETED }),
      null,
    );
  });

  it('updateAfterExecution normal', async () => {
    const repo = new InMemoryTaskRepository();
    const t = await repo.insert(makeIntent({ intentId: 'i1' }));
    const future = new Date(Date.now() + 60000).toISOString();
    const claimed = await repo.tryClaim(t.taskId, 'w1', future, 1, new Date());
    const lv = claimed.task?.lease?.leaseVersion ?? 0;
    const updated = await repo.updateAfterExecution(t.taskId, lv, {
      status: TaskStatus.COMPLETED,
      resultRef: 'ref://done',
    });
    assert.equal(updated?.status, TaskStatus.COMPLETED);
    assert.equal(updated?.resultRef, 'ref://done');
  });

  it('listDueTaskIds', async () => {
    const repo = new InMemoryTaskRepository();
    const past = new Date(Date.now() - 10000).toISOString();
    const future = new Date(Date.now() + 60000).toISOString();
    await repo.insert(makeIntent({ intentId: 'i1', notBefore: past }));
    await repo.insert(makeIntent({ intentId: 'i2', notBefore: future }));
    const ids = await repo.listDueTaskIds(new Date().toISOString(), 10);
    assert.equal(ids.length, 1);
    assert.ok(ids[0].includes('i1'));
  });

  it('listDeadlineTaskIds only DEADLINE', async () => {
    const repo = new InMemoryTaskRepository();
    const past = new Date(Date.now() - 10000).toISOString();
    await repo.insert(makeIntent({ intentId: 'd1', taskType: TaskType.DEADLINE, notBefore: past }));
    await repo.insert(
      makeIntent({ intentId: 'f1', taskType: TaskType.FILE_CHECK, notBefore: past }),
    );
    const ids = await repo.listDeadlineTaskIds(new Date().toISOString(), 10);
    assert.equal(ids.length, 1);
    assert.ok(ids[0].includes('d1'));
  });

  it('listExpiredLeaseTaskIds', async () => {
    const repo = new InMemoryTaskRepository();
    const past = new Date(Date.now() - 10000).toISOString();
    const future = new Date(Date.now() + 60000).toISOString();
    const t1 = await repo.insert(makeIntent({ intentId: 'i1' }));
    await repo.tryClaim(t1.taskId, 'w1', past, 1, new Date(Date.now() - 20000));
    const t2 = await repo.insert(makeIntent({ intentId: 'i2' }));
    await repo.tryClaim(t2.taskId, 'w2', future, 1, new Date());
    const ids = await repo.listExpiredLeaseTaskIds(new Date().toISOString(), 10);
    assert.equal(ids.length, 1);
    assert.ok(ids[0].includes('i1'));
  });

  it('backlogSummary', async () => {
    const repo = new InMemoryTaskRepository();
    await repo.insert(makeIntent({ intentId: 'p1' }));
    await repo.insert(makeIntent({ intentId: 'p2' }));
    const t = await repo.insert(makeIntent({ intentId: 'l1' }));
    await repo.tryClaim(t.taskId, 'w1', new Date(Date.now() + 60000).toISOString(), 1, new Date());
    const summary = await repo.backlogSummary();
    assert.equal(summary.pending, 2);
    assert.equal(summary.leased, 1);
    assert.ok(summary.perType[TaskType.FILE_CHECK] !== undefined);
  });
});
