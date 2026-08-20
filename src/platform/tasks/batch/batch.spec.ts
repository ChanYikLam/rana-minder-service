import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BatchStatus, BatchItemStatus } from '../contracts';
import type { BatchItemInput, BatchItemResult, BatchRecord, TaskScope } from '../contracts';
import { BatchOrchestrator } from './batch-orchestrator';
import { InMemoryBatchStore } from './batch-store';
import { DevelopmentBatchItemAuthorization } from './batch-authorization';
import { DevelopmentBatchItemExecutor } from './batch-item-executor';
import {
  summarizeBatch,
  deriveBatchStatus,
  selectRetryableItems,
  validateRetryBatch,
  isRetryableItemResult,
} from './batch-rules';

function makeItems(count: number): BatchItemInput[] {
  return Array.from({ length: count }, (_, i) => ({
    itemId: `item-${i + 1}`,
    version: 1,
    input: { name: `item-${i + 1}` },
    idempotencyKey: `ik:item-${i + 1}`,
  }));
}

describe('batch-rules', () => {
  it('deriveBatchStatus ALL_SUCCEEDED when total=0', () => {
    assert.equal(deriveBatchStatus(0, 0, 0, 0, 0), BatchStatus.ALL_SUCCEEDED);
  });
  it('deriveBatchStatus EXECUTING when completed < total', () => {
    assert.equal(deriveBatchStatus(5, 3, 3, 0, 0), BatchStatus.EXECUTING);
  });
  it('deriveBatchStatus ALL_SUCCEEDED', () => {
    assert.equal(deriveBatchStatus(5, 5, 5, 0, 0), BatchStatus.ALL_SUCCEEDED);
  });
  it('deriveBatchStatus ALL_FAILED', () => {
    assert.equal(deriveBatchStatus(5, 5, 0, 5, 0), BatchStatus.ALL_FAILED);
  });
  it('deriveBatchStatus PARTIALLY_SUCCEEDED', () => {
    assert.equal(deriveBatchStatus(5, 5, 3, 2, 0), BatchStatus.PARTIALLY_SUCCEEDED);
  });
  it('summarizeBatch counts correctly', () => {
    const items = makeItems(3);
    const results: BatchItemResult[] = [
      { itemId: 'item-1', status: BatchItemStatus.SUCCEEDED },
      { itemId: 'item-2', status: BatchItemStatus.FAILED },
      { itemId: 'item-3', status: BatchItemStatus.REJECTED },
    ];
    const summary = summarizeBatch({ batchId: 'b1', frozenItems: items, itemResults: results });
    assert.equal(summary.total, 3);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.rejected, 1);
  });
  it('selectRetryableItems only FAILED', () => {
    const items = makeItems(4);
    const results: BatchItemResult[] = [
      { itemId: 'item-1', status: BatchItemStatus.SUCCEEDED },
      { itemId: 'item-2', status: BatchItemStatus.FAILED },
      { itemId: 'item-3', status: BatchItemStatus.REJECTED },
      { itemId: 'item-4', status: BatchItemStatus.FAILED },
    ];
    const retryable = selectRetryableItems(items, results);
    assert.equal(retryable.length, 2);
    assert.deepEqual(
      retryable.map((i) => i.itemId),
      ['item-2', 'item-4'],
    );
  });
  it('validateRetryBatch operation type mismatch', () => {
    const original = {
      frozenItems: makeItems(2),
      itemResults: [],
      operationType: 'invite',
      businessType: 'member',
      scope: { kind: 'CLUB' as const, clubId: 'c1' },
    };
    const r = validateRetryBatch(original, makeItems(1), 'delete', 'member', 'CLUB');
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes('操作类型'));
  });
  it('validateRetryBatch new item rejected', () => {
    const original = {
      frozenItems: makeItems(2),
      itemResults: [],
      operationType: 'invite',
      businessType: 'member',
      scope: { kind: 'CLUB' as const, clubId: 'c1' },
    };
    const r = validateRetryBatch(
      original,
      [{ itemId: 'item-99', version: 1, input: {}, idempotencyKey: 'ik:99' }],
      'invite',
      'member',
      'CLUB',
    );
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes('新对象'));
  });
  it('validateRetryBatch valid', () => {
    const items = makeItems(2);
    const results: BatchItemResult[] = [
      { itemId: 'item-1', status: BatchItemStatus.FAILED },
      { itemId: 'item-2', status: BatchItemStatus.FAILED },
    ];
    const original = {
      frozenItems: items,
      itemResults: results,
      operationType: 'invite',
      businessType: 'member',
      scope: { kind: 'CLUB' as const, clubId: 'c1' },
    };
    const r = validateRetryBatch(original, [items[0]], 'invite', 'member', 'CLUB');
    assert.equal(r.ok, true);
  });
  it('isRetryableItemResult', () => {
    assert.equal(isRetryableItemResult({ itemId: '1', status: BatchItemStatus.FAILED }), true);
    assert.equal(isRetryableItemResult({ itemId: '1', status: BatchItemStatus.SUCCEEDED }), false);
  });
});

describe('InMemoryBatchStore', () => {
  it('save increments version', async () => {
    const store = new InMemoryBatchStore();
    const batch: BatchRecord = {
      batchId: 'b1',
      previewVersion: 1,
      version: 1,
      scope: { kind: 'CLUB', clubId: 'c1' },
      operationType: 'invite',
      businessType: 'member',
      status: BatchStatus.PREVIEWED,
      frozenItems: [],
      itemResults: [],
      createdAt: new Date().toISOString(),
    };
    await store.save(batch);
    const found = await store.findById('b1');
    assert.equal(found?.version, 2);
  });
  it('saveIfVersion success', async () => {
    const store = new InMemoryBatchStore();
    const batch: BatchRecord = {
      batchId: 'b1',
      previewVersion: 1,
      version: 1,
      scope: { kind: 'CLUB', clubId: 'c1' },
      operationType: 'invite',
      businessType: 'member',
      status: BatchStatus.PREVIEWED,
      frozenItems: [],
      itemResults: [],
      createdAt: new Date().toISOString(),
    };
    await store.save(batch);
    const ok = await store.saveIfVersion(
      { ...batch, version: 2, status: BatchStatus.EXECUTING },
      2,
    );
    assert.equal(ok, true);
  });
  it('saveIfVersion version mismatch', async () => {
    const store = new InMemoryBatchStore();
    const batch: BatchRecord = {
      batchId: 'b1',
      previewVersion: 1,
      version: 1,
      scope: { kind: 'CLUB', clubId: 'c1' },
      operationType: 'invite',
      businessType: 'member',
      status: BatchStatus.PREVIEWED,
      frozenItems: [],
      itemResults: [],
      createdAt: new Date().toISOString(),
    };
    await store.save(batch);
    const ok = await store.saveIfVersion(batch, 999);
    assert.equal(ok, false);
  });
  it('findByParentBatchId', async () => {
    const store = new InMemoryBatchStore();
    const parent: BatchRecord = {
      batchId: 'b1',
      previewVersion: 1,
      version: 1,
      scope: { kind: 'CLUB', clubId: 'c1' },
      operationType: 'invite',
      businessType: 'member',
      status: BatchStatus.PARTIALLY_SUCCEEDED,
      frozenItems: [],
      itemResults: [],
      createdAt: new Date().toISOString(),
    };
    const child: BatchRecord = {
      batchId: 'b1:retry:1',
      parentBatchId: 'b1',
      previewVersion: 1,
      version: 1,
      scope: { kind: 'CLUB', clubId: 'c1' },
      operationType: 'invite',
      businessType: 'member',
      status: BatchStatus.RETRYING_FAILED,
      frozenItems: [],
      itemResults: [],
      createdAt: new Date().toISOString(),
    };
    await store.save(parent);
    await store.save(child);
    const children = await store.findByParentBatchId('b1');
    assert.equal(children.length, 1);
    assert.equal(children[0].batchId, 'b1:retry:1');
  });
});

describe('BatchOrchestrator', () => {
  function makeOrch(auth?: any, exec?: any) {
    const store = new InMemoryBatchStore();
    const authorization = auth ?? { verify: async () => ({ ok: true }) };
    const executor = exec ?? {
      execute: async (
        _pid: string,
        _op: string,
        _bt: string,
        _scope: TaskScope,
        item: BatchItemInput,
      ) => ({
        itemId: item.itemId,
        status: BatchItemStatus.SUCCEEDED,
        resultRef: `ref:${item.itemId}`,
      }),
    };
    return new BatchOrchestrator(store, authorization, executor);
  }

  const scope: TaskScope = { kind: 'CLUB', clubId: 'c1' };

  it('preview non-CLUB throws', async () => {
    const orch = makeOrch();
    await assert.rejects(
      () =>
        orch.preview(
          'b1',
          { kind: 'PLATFORM' },
          'invite',
          'member',
          [{ itemId: 'i1', version: 1, input: {}, idempotencyKey: 'ik:1' }],
          'op1',
          new Date(),
        ),
      /必须固定一个社团/,
    );
  });

  it('preview empty items throws', async () => {
    const orch = makeOrch();
    await assert.rejects(
      () => orch.preview('b1', scope, 'invite', 'member', [], 'op1', new Date()),
      /为空/,
    );
  });

  it('preview duplicate itemId throws', async () => {
    const orch = makeOrch();
    await assert.rejects(
      () =>
        orch.preview(
          'b1',
          scope,
          'invite',
          'member',
          [
            { itemId: 'i1', version: 1, input: {}, idempotencyKey: 'ik:1' },
            { itemId: 'i1', version: 2, input: {}, idempotencyKey: 'ik:2' },
          ],
          'op1',
          new Date(),
        ),
      /重复/,
    );
  });

  it('preview success returns BatchPreview', async () => {
    const orch = makeOrch();
    const preview = await orch.preview(
      'b1',
      scope,
      'invite',
      'member',
      [{ itemId: 'i1', version: 1, input: { name: 'test' }, idempotencyKey: 'ik:1' }],
      'op1',
      new Date(),
    );
    assert.equal(preview.batchId, 'b1');
    assert.equal(preview.previewVersion, 1);
    assert.equal(preview.items.length, 1);
    assert.equal(preview.createdBy, 'op1');
  });

  it('confirmAndFreeze version mismatch throws', async () => {
    const orch = makeOrch();
    await orch.preview(
      'b1',
      scope,
      'invite',
      'member',
      [{ itemId: 'i1', version: 1, input: {}, idempotencyKey: 'ik:1' }],
      'op1',
      new Date(),
    );
    await assert.rejects(
      () => orch.confirmAndFreeze('b1', 999, 'op1', new Date()),
      /预览版本不匹配/,
    );
  });

  it('confirmAndFreeze success', async () => {
    const orch = makeOrch();
    await orch.preview(
      'b1',
      scope,
      'invite',
      'member',
      [{ itemId: 'i1', version: 1, input: {}, idempotencyKey: 'ik:1' }],
      'op1',
      new Date(),
    );
    const frozen = await orch.confirmAndFreeze('b1', 1, 'op1', new Date());
    assert.equal(frozen.status, BatchStatus.EXECUTING);
    assert.ok(frozen.confirmedAt !== undefined);
  });

  it('executeFrozenBatch auth rejected', async () => {
    const orch = makeOrch({ verify: async () => ({ ok: false, reason: '无权操作' }) });
    await orch.preview(
      'b1',
      scope,
      'invite',
      'member',
      [{ itemId: 'i1', version: 1, input: {}, idempotencyKey: 'ik:1' }],
      'op1',
      new Date(),
    );
    await orch.confirmAndFreeze('b1', 1, 'op1', new Date());
    const task = { taskId: 'task-1', payload: { batchId: 'b1', operatorId: 'op1' } } as any;
    const result = await orch.executeFrozenBatch(task, new Date());
    assert.equal(result.itemResults[0].status, BatchItemStatus.REJECTED);
  });

  it('executeFrozenBatch execution error', async () => {
    const orch = makeOrch(undefined, {
      execute: async () => {
        throw new Error('exec error');
      },
    });
    await orch.preview(
      'b1',
      scope,
      'invite',
      'member',
      [{ itemId: 'i1', version: 1, input: {}, idempotencyKey: 'ik:1' }],
      'op1',
      new Date(),
    );
    await orch.confirmAndFreeze('b1', 1, 'op1', new Date());
    const task = { taskId: 'task-1', payload: { batchId: 'b1', operatorId: 'op1' } } as any;
    const result = await orch.executeFrozenBatch(task, new Date());
    assert.equal(result.itemResults[0].status, BatchItemStatus.FAILED);
  });

  it('retryFailedItems creates retry batch', async () => {
    const store = new InMemoryBatchStore();
    const batch: BatchRecord = {
      batchId: 'b1',
      previewVersion: 1,
      version: 1,
      scope,
      operationType: 'invite',
      businessType: 'member',
      status: BatchStatus.PARTIALLY_SUCCEEDED,
      frozenItems: [
        { itemId: 'i1', version: 1, input: {}, idempotencyKey: 'ik:1' },
        { itemId: 'i2', version: 1, input: {}, idempotencyKey: 'ik:2' },
      ],
      itemResults: [
        { itemId: 'i1', status: BatchItemStatus.SUCCEEDED, resultRef: 'ref:i1' },
        { itemId: 'i2', status: BatchItemStatus.FAILED, reason: 'error' },
      ],
      createdAt: new Date().toISOString(),
    };
    await store.save(batch);
    const auth = { verify: async () => ({ ok: true }) };
    const exec = {
      execute: async (
        _pid: string,
        _op: string,
        _bt: string,
        _scope: TaskScope,
        item: BatchItemInput,
      ) => ({
        itemId: item.itemId,
        status: BatchItemStatus.SUCCEEDED,
        resultRef: `ref:${item.itemId}`,
      }),
    };
    const orch = new BatchOrchestrator(store, auth, exec);
    const retry = await orch.retryFailedItems('b1', 'op1', new Date());
    assert.equal(retry.status, BatchStatus.RETRYING_FAILED);
    assert.equal(retry.parentBatchId, 'b1');
    assert.equal(retry.frozenItems.length, 1);
    assert.equal(retry.frozenItems[0].itemId, 'i2');
  });
});

describe('DevelopmentBatchItemAuthorization', () => {
  it('verify returns ok', async () => {
    const auth = new DevelopmentBatchItemAuthorization();
    const r = await auth.verify('p1', 'invite', 'member', {
      itemId: 'i1',
      version: 1,
      input: {},
      idempotencyKey: 'ik:1',
    });
    assert.equal(r.ok, true);
  });
});

describe('DevelopmentBatchItemExecutor', () => {
  it('execute returns SUCCEEDED', async () => {
    const exec = new DevelopmentBatchItemExecutor();
    const r = await exec.execute(
      'p1',
      'invite',
      'member',
      { kind: 'CLUB', clubId: 'c1' },
      { itemId: 'i1', version: 1, input: {}, idempotencyKey: 'ik:1' },
    );
    assert.equal(r.status, BatchItemStatus.SUCCEEDED);
  });
});
