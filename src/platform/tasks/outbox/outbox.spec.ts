import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryTransactionOutboxStore } from './in-memory-transactional-outbox';
import { TaskIntentOutbox } from './task-intent-outbox';
import type { TaskIntent } from '../contracts';
import { TaskType } from '../contracts/task-type';

function makeIntent(overrides: Partial<TaskIntent> = {}): TaskIntent {
  const now = new Date().toISOString();
  return {
    intentId: 'intent-1', taskType: TaskType.FILE_CHECK,
    idempotencyKey: 'ik:1', scope: { kind: 'CLUB', clubId: 'c1' },
    source: { objectType: 'f', objectId: '1', version: 1, scope: { kind: 'CLUB', clubId: 'c1' } },
    payload: {}, notBefore: now, createdAt: now, ...overrides,
  };
}

describe('InMemoryTransactionOutboxStore', () => {
  it('append and listPending', async () => {
    const store = new InMemoryTransactionOutboxStore();
    await store.append(makeIntent({ intentId: 'i1' }));
    const pending = await store.listPending(10);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].intentId, 'i1');
  });
  it('append same intentId idempotent', async () => {
    const store = new InMemoryTransactionOutboxStore();
    await store.append(makeIntent({ intentId: 'i1' }));
    await store.append(makeIntent({ intentId: 'i1' }));
    assert.equal((await store.listPending(10)).length, 1);
  });
  it('listPending limit', async () => {
    const store = new InMemoryTransactionOutboxStore();
    for (let i = 0; i < 10; i++) await store.append(makeIntent({ intentId: `i${i}` }));
    assert.equal((await store.listPending(3)).length, 3);
  });
  it('markForwarded removes from pending', async () => {
    const store = new InMemoryTransactionOutboxStore();
    await store.append(makeIntent({ intentId: 'i1' }));
    await store.markForwarded('i1');
    assert.equal((await store.listPending(10)).length, 0);
  });
  it('markForwarded nonexistent does not throw', async () => {
    const store = new InMemoryTransactionOutboxStore();
    await store.markForwarded('nonexistent');
  });
});

describe('TaskIntentOutbox', () => {
  it('register calls store.append', async () => {
    const store = new InMemoryTransactionOutboxStore();
    const outbox = new TaskIntentOutbox(store);
    await outbox.register(makeIntent({ intentId: 'i1' }));
    assert.equal((await store.listPending(10)).length, 1);
  });
  it('forwardPending forwards and marks', async () => {
    const store = new InMemoryTransactionOutboxStore();
    const outbox = new TaskIntentOutbox(store);
    await store.append(makeIntent({ intentId: 'i1' }));
    const received: string[] = [];
    const fwd = await outbox.forwardPending(10, async (i) => { received.push(i.intentId); });
    assert.equal(fwd, 1);
    assert.deepEqual(received, ['i1']);
    assert.equal((await store.listPending(10)).length, 0);
  });
  it('forwardPending sink failure keeps pending', async () => {
    const store = new InMemoryTransactionOutboxStore();
    const outbox = new TaskIntentOutbox(store);
    await store.append(makeIntent({ intentId: 'i1' }));
    await store.append(makeIntent({ intentId: 'i2' }));
    await store.append(makeIntent({ intentId: 'i3' }));
    const fwd = await outbox.forwardPending(10, async (i) => {
      if (i.intentId === 'i2') throw new Error('fail');
    });
    assert.equal(fwd, 2);
    const pending = await store.listPending(10);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].intentId, 'i2');
  });
  it('forwardPending empty returns 0', async () => {
    const store = new InMemoryTransactionOutboxStore();
    const outbox = new TaskIntentOutbox(store);
    assert.equal(await outbox.forwardPending(10, async () => {}), 0);
  });
});
