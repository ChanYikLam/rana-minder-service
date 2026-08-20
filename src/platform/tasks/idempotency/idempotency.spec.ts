import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryIdempotencyStore } from './in-memory-idempotency-store';
import { RecoveryReplayConvergence } from './recovery-replay';
import { IdempotencyRecordStatus } from './idempotency-record';
import {
  deriveIdempotencyKey, isValidIdempotencyKey,
  assertIdempotencyKeyDistinctFromTrackingNumber,
} from './idempotency-key';
import type { TaskRepository, TaskRecord } from '../contracts';
import { TaskStatus, TaskType } from '../contracts';

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

describe('deriveIdempotencyKey', () => {
  it('club scope', () => {
    assert.equal(deriveIdempotencyKey('invite', { objectType: 'member', objectId: 'm1', version: 3, scope: { kind: 'CLUB', clubId: 'c1' } }), 'invite:club:c1:member:m1:v3');
  });
  it('union scope', () => {
    assert.equal(deriveIdempotencyKey('invite', { objectType: 'member', objectId: 'm1', version: 3, scope: { kind: 'UNION', unionId: 'u1' } }), 'invite:union:u1:member:m1:v3');
  });
  it('platform scope', () => {
    assert.equal(deriveIdempotencyKey('sync', { objectType: 'user', objectId: 'u1', version: 1, scope: { kind: 'PLATFORM' } }), 'sync:platform:user:u1:v1');
  });
  it('version null uses current', () => {
    assert.equal(deriveIdempotencyKey('invite', { objectType: 'member', objectId: 'm1', version: 3, scope: { kind: 'CLUB', clubId: 'c1' } }, null), 'invite:club:c1:member:m1:current');
  });
});

describe('isValidIdempotencyKey', () => {
  it('valid key', () => { assert.equal(isValidIdempotencyKey('invite:club:c1:member:m1:v1'), true); });
  it('empty string', () => { assert.equal(isValidIdempotencyKey(''), false); });
  it('512 chars valid', () => { assert.equal(isValidIdempotencyKey('a'.repeat(512)), true); });
  it('513 chars invalid', () => { assert.equal(isValidIdempotencyKey('a'.repeat(513)), false); });
});

describe('assertIdempotencyKeyDistinctFromTrackingNumber', () => {
  it('same throws', () => {
    assert.throws(() => assertIdempotencyKeyDistinctFromTrackingNumber('same', 'same'), /不得混同/);
  });
  it('different ok', () => {
    assert.doesNotThrow(() => assertIdempotencyKeyDistinctFromTrackingNumber('a', 'b'));
  });
});

describe('InMemoryIdempotencyStore', () => {
  it('begin first true', async () => {
    const store = new InMemoryIdempotencyStore();
    assert.equal(await store.begin('k1', 'intent-1'), true);
    const r = await store.find('k1');
    assert.equal(r?.status, IdempotencyRecordStatus.EXECUTING);
  });
  it('begin duplicate false', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.begin('k1', 'intent-1');
    assert.equal(await store.begin('k1', 'intent-2'), false);
  });
  it('find nonexistent null', async () => {
    assert.equal(await new InMemoryIdempotencyStore().find('x'), null);
  });
  it('complete', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.begin('k1', 'intent-1');
    await store.complete('k1', 'intent-1', 'ref://r');
    assert.equal((await store.find('k1'))?.status, IdempotencyRecordStatus.COMPLETED);
  });
  it('fail', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.begin('k1', 'intent-1');
    await store.fail('k1', 'intent-1');
    assert.equal((await store.find('k1'))?.status, IdempotencyRecordStatus.FAILED);
  });
});

describe('RecoveryReplayConvergence', () => {
  function makeRepo(findByIntentIdFn: TaskRepository['findByIntentId'] = async () => null): TaskRepository {
    return {
      insert: async () => makeTask(), findById: async () => null,
      findByIntentId: findByIntentIdFn, findByIdempotencyKey: async () => null,
      tryClaim: async () => ({ claimed: true, task: makeTask() }),
      updateAfterExecution: async () => makeTask(),
      listDueTaskIds: async () => [], listDeadlineTaskIds: async () => [],
      listExpiredLeaseTaskIds: async () => [],
      backlogSummary: async () => ({ pending: 0, leased: 0, retryableFailed: 0, uncertain: 0, manualIntervention: 0, completed: 0, perType: {} as Record<TaskType, number> }),
    } as TaskRepository;
  }

  it('no record -> allowed true', async () => {
    const store = new InMemoryIdempotencyStore();
    const c = new RecoveryReplayConvergence(makeRepo(), store);
    const r = await c.convergeBeforeExecution(makeTask({ idempotencyKey: 'ik:1' }), new Date());
    assert.equal(r.allowed, true);
  });
  it('COMPLETED -> allowed false + resultRef', async () => {
    const store = new InMemoryIdempotencyStore();
    const c = new RecoveryReplayConvergence(makeRepo(), store);
    const task = makeTask({ idempotencyKey: 'ik:1' });
    await store.begin('ik:1', task.intentId);
    await store.complete('ik:1', task.intentId, 'ref://done');
    const r = await c.convergeBeforeExecution(task, new Date());
    assert.equal(r.allowed, false);
    assert.equal(r.resultRef, 'ref://done');
  });
  it('EXECUTING valid lease -> allowed false', async () => {
    const store = new InMemoryIdempotencyStore();
    const future = new Date(Date.now() + 60000).toISOString();
    const fresh = makeTask({ taskId: 't1', intentId: 'intent-1', idempotencyKey: 'ik:1', lease: { workerId: 'w1', leaseVersion: 1, leaseUntil: future, leasedAt: new Date().toISOString() } });
    const c = new RecoveryReplayConvergence(makeRepo(async () => fresh), store);
    const task = makeTask({ idempotencyKey: 'ik:1', intentId: 'intent-1' });
    await store.begin('ik:1', task.intentId);
    assert.equal((await c.convergeBeforeExecution(task, new Date())).allowed, false);
  });
  it('EXECUTING expired lease -> allowed true', async () => {
    const store = new InMemoryIdempotencyStore();
    const past = new Date(Date.now() - 10000).toISOString();
    const expired = makeTask({ taskId: 't1', intentId: 'intent-1', idempotencyKey: 'ik:1', lease: { workerId: 'w1', leaseVersion: 1, leaseUntil: past, leasedAt: new Date(Date.now() - 20000).toISOString() } });
    const c = new RecoveryReplayConvergence(makeRepo(async () => expired), store);
    const task = makeTask({ idempotencyKey: 'ik:1', intentId: 'intent-1' });
    await store.begin('ik:1', task.intentId);
    assert.equal((await c.convergeBeforeExecution(task, new Date())).allowed, true);
  });
  it('FAILED -> allowed true', async () => {
    const store = new InMemoryIdempotencyStore();
    const c = new RecoveryReplayConvergence(makeRepo(), store);
    const task = makeTask({ idempotencyKey: 'ik:1', intentId: 'intent-1' });
    await store.begin('ik:1', task.intentId);
    await store.fail('ik:1', task.intentId);
    assert.equal((await c.convergeBeforeExecution(task, new Date())).allowed, true);
  });
  it('convergeAfterSuccess', async () => {
    const store = new InMemoryIdempotencyStore();
    const c = new RecoveryReplayConvergence(makeRepo(), store);
    const task = makeTask({ idempotencyKey: 'ik:1', intentId: 'intent-1' });
    await store.begin('ik:1', task.intentId);
    await c.convergeAfterSuccess(task, 'ref://r');
    assert.equal((await store.find('ik:1'))?.status, IdempotencyRecordStatus.COMPLETED);
  });
  it('convergeAfterFailure', async () => {
    const store = new InMemoryIdempotencyStore();
    const c = new RecoveryReplayConvergence(makeRepo(), store);
    const task = makeTask({ idempotencyKey: 'ik:1', intentId: 'intent-1' });
    await store.begin('ik:1', task.intentId);
    await c.convergeAfterFailure(task);
    assert.equal((await store.find('ik:1'))?.status, IdempotencyRecordStatus.FAILED);
  });
});
