import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryIdempotencyStore } from './in-memory-idempotency-store';
import { RecoveryReplayConvergence } from './recovery-replay';
import { IdempotencyRecordStatus } from './idempotency-record';
import {
  deriveIdempotencyKey,
  isValidIdempotencyKey,
  assertIdempotencyKeyDistinctFromTrackingNumber,
} from './idempotency-key';
import type { TaskRecord } from '../contracts';
import { TaskStatus, TaskType } from '../contracts';

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    taskId: 'task-1',
    taskType: TaskType.FILE_CHECK,
    status: TaskStatus.PENDING,
    intentId: 'intent-1',
    idempotencyKey: 'ik:1',
    scope: { kind: 'CLUB', clubId: 'c1' },
    source: { objectType: 'f', objectId: '1', version: 1, scope: { kind: 'CLUB', clubId: 'c1' } },
    payload: {},
    lease: null,
    attempts: 0,
    maxAttempts: 5,
    notBefore: now,
    failure: null,
    resultRef: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('deriveIdempotencyKey', () => {
  it('club scope', () => {
    assert.equal(
      deriveIdempotencyKey('invite', {
        objectType: 'member',
        objectId: 'm1',
        version: 3,
        scope: { kind: 'CLUB', clubId: 'c1' },
      }),
      'invite:club:c1:member:m1:v3',
    );
  });
  it('union scope', () => {
    assert.equal(
      deriveIdempotencyKey('invite', {
        objectType: 'member',
        objectId: 'm1',
        version: 3,
        scope: { kind: 'UNION', unionId: 'u1' },
      }),
      'invite:union:u1:member:m1:v3',
    );
  });
  it('platform scope', () => {
    assert.equal(
      deriveIdempotencyKey('sync', {
        objectType: 'user',
        objectId: 'u1',
        version: 1,
        scope: { kind: 'PLATFORM' },
      }),
      'sync:platform:user:u1:v1',
    );
  });
  it('version null uses current', () => {
    assert.equal(
      deriveIdempotencyKey(
        'invite',
        { objectType: 'member', objectId: 'm1', version: 3, scope: { kind: 'CLUB', clubId: 'c1' } },
        null,
      ),
      'invite:club:c1:member:m1:current',
    );
  });
});

describe('isValidIdempotencyKey', () => {
  it('valid key', () => {
    assert.equal(isValidIdempotencyKey('invite:club:c1:member:m1:v1'), true);
  });
  it('empty string', () => {
    assert.equal(isValidIdempotencyKey(''), false);
  });
  it('512 chars valid', () => {
    assert.equal(isValidIdempotencyKey('a'.repeat(512)), true);
  });
  it('513 chars invalid', () => {
    assert.equal(isValidIdempotencyKey('a'.repeat(513)), false);
  });
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
    assert.equal(await store.begin('k1', 'intent-1', new Date(Date.now() - 1000).toISOString()), true);
    const r = await store.find('k1');
    assert.equal(r?.status, IdempotencyRecordStatus.EXECUTING);
  });
  it('begin duplicate false', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.begin('k1', 'intent-1', new Date(Date.now() - 1000).toISOString());
    assert.equal(await store.begin('k1', 'intent-2', new Date(Date.now() - 1000).toISOString()), false);
  });
  it('find nonexistent null', async () => {
    assert.equal(await new InMemoryIdempotencyStore().find('x'), null);
  });
  it('complete', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.begin('k1', 'intent-1', new Date(Date.now() - 1000).toISOString());
    await store.complete('k1', 'intent-1', 'ref://r');
    assert.equal((await store.find('k1'))?.status, IdempotencyRecordStatus.COMPLETED);
  });
  it('fail', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.begin('k1', 'intent-1', new Date(Date.now() - 1000).toISOString());
    await store.fail('k1', 'intent-1');
    assert.equal((await store.find('k1'))?.status, IdempotencyRecordStatus.FAILED);
  });
});

describe('RecoveryReplayConvergence', () => {
  it('no record -> allowed true', async () => {
    const store = new InMemoryIdempotencyStore();
    const c = new RecoveryReplayConvergence(store);
    const r = await c.convergeBeforeExecution(makeTask({ idempotencyKey: 'ik:1' }), new Date());
    assert.equal(r.allowed, true);
  });
  it('COMPLETED -> allowed false + resultRef', async () => {
    const store = new InMemoryIdempotencyStore();
    const c = new RecoveryReplayConvergence(store);
    const task = makeTask({ idempotencyKey: 'ik:1' });
    await store.begin('ik:1', task.intentId, new Date(Date.now() - 1000).toISOString());
    await store.complete('ik:1', task.intentId, 'ref://done');
    const r = await c.convergeBeforeExecution(task, new Date());
    assert.equal(r.allowed, false);
    assert.equal(r.resultRef, 'ref://done');
  });
  it('EXECUTING 且执行任期未过期 -> allowed false（另一 worker 仍在执行）', async () => {
    const store = new InMemoryIdempotencyStore();
    const c = new RecoveryReplayConvergence(store);
    const task = makeTask({ idempotencyKey: 'ik:1', intentId: 'intent-1' });
    // 记录声明执行中的任期仍在未来 → 视为活跃，禁止重放
    await store.begin('ik:1', task.intentId, new Date(Date.now() + 60000).toISOString());
    assert.equal((await c.convergeBeforeExecution(task, new Date())).allowed, false);
  });
  it('EXECUTING 但执行任期已超时 -> allowed true（崩溃后恢复重放，BUG-004）', async () => {
    const store = new InMemoryIdempotencyStore();
    const c = new RecoveryReplayConvergence(store);
    const task = makeTask({ idempotencyKey: 'ik:1', intentId: 'intent-1' });
    // 记录声明执行中的任期已过去 → 崩溃恢复，允许重放（不再取任务表当前行新租约）
    await store.begin('ik:1', task.intentId, new Date(Date.now() - 10000).toISOString());
    assert.equal((await c.convergeBeforeExecution(task, new Date())).allowed, true);
  });
  it('FAILED -> allowed true', async () => {
    const store = new InMemoryIdempotencyStore();
    const c = new RecoveryReplayConvergence(store);
    const task = makeTask({ idempotencyKey: 'ik:1', intentId: 'intent-1' });
    await store.begin('ik:1', task.intentId, new Date(Date.now() - 1000).toISOString());
    await store.fail('ik:1', task.intentId);
    assert.equal((await c.convergeBeforeExecution(task, new Date())).allowed, true);
  });
  it('convergeAfterSuccess', async () => {
    const store = new InMemoryIdempotencyStore();
    const c = new RecoveryReplayConvergence(store);
    const task = makeTask({ idempotencyKey: 'ik:1', intentId: 'intent-1' });
    await store.begin('ik:1', task.intentId, new Date(Date.now() - 1000).toISOString());
    await c.convergeAfterSuccess(task, 'ref://r');
    assert.equal((await store.find('ik:1'))?.status, IdempotencyRecordStatus.COMPLETED);
  });
  it('convergeAfterFailure', async () => {
    const store = new InMemoryIdempotencyStore();
    const c = new RecoveryReplayConvergence(store);
    const task = makeTask({ idempotencyKey: 'ik:1', intentId: 'intent-1' });
    await store.begin('ik:1', task.intentId, new Date(Date.now() - 1000).toISOString());
    await c.convergeAfterFailure(task);
    assert.equal((await store.find('ik:1'))?.status, IdempotencyRecordStatus.FAILED);
  });
});
