/**
 * 安全控制独立验证：SEC-CTL-023（批量冻结目标与重试边界）。
 *
 * 权威来源：docs/specification/安全设计与实现级威胁模型-v1.0.md §5、§13；
 * SEC-VER-013（新增目标、改变参数、混合类型、重试成功项均拒绝）。
 *
 * 验证路径（真实纯函数，无 pg/jose 依赖）：
 * - src/platform/tasks/batch/batch-rules.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectRetryableItems,
  summarizeBatch,
  validateRetryBatch,
} from '../../src/platform/tasks/batch/batch-rules';
import { BatchItemStatus, BatchStatus } from '../../src/platform/tasks/contracts';
import type {
  BatchItemInput,
  BatchItemResult,
  BatchRecord,
} from '../../src/platform/tasks/contracts';

function item(id: string): BatchItemInput {
  return { itemId: id, version: 1, input: {}, idempotencyKey: `k-${id}` };
}

type OriginalBatch = Pick<
  BatchRecord,
  'frozenItems' | 'itemResults' | 'operationType' | 'businessType' | 'scope'
>;

const ORIGINAL: OriginalBatch = {
  frozenItems: [item('a'), item('b'), item('c')],
  itemResults: [
    { itemId: 'a', status: BatchItemStatus.SUCCEEDED },
    { itemId: 'b', status: BatchItemStatus.FAILED },
    { itemId: 'c', status: BatchItemStatus.FAILED },
  ] as BatchItemResult[],
  operationType: 'INVITE_BATCH',
  businessType: 'club',
  scope: { kind: 'CLUB', clubId: 'c1' },
};

describe('SEC-CTL-023 批量重试仅包含原失败项且冻结语义不扩散', () => {
  it('SEC-CTL-023：仅原失败项可通过校验', () => {
    const verdict = validateRetryBatch(ORIGINAL, [item('b')], 'INVITE_BATCH', 'club', 'CLUB');
    assert.deepEqual(verdict, { ok: true });
  });

  it('SEC-CTL-023：原成功项、批次外新对象、重复项一律拒绝', () => {
    for (const bad of [
      { items: [item('a')], reason: /原成功项/ },
      { items: [item('zz-new')], reason: /新对象/ },
      { items: [item('b'), item('b')], reason: /重复/ },
    ]) {
      const verdict = validateRetryBatch(ORIGINAL, bad.items, 'INVITE_BATCH', 'club', 'CLUB');
      assert.equal(verdict.ok, false, JSON.stringify(bad.items));
      assert.match(verdict.reason ?? '', bad.reason);
    }
  });

  it('SEC-CTL-023：操作类型/业务类型/作用域与原批次不一致拒绝（冻结不可改写）', () => {
    assert.equal(validateRetryBatch(ORIGINAL, [item('b')], 'OTHER_OP', 'club', 'CLUB').ok, false);
    assert.equal(
      validateRetryBatch(ORIGINAL, [item('b')], 'INVITE_BATCH', 'joint', 'CLUB').ok,
      false,
    );
    assert.equal(
      validateRetryBatch(ORIGINAL, [item('b')], 'INVITE_BATCH', 'club', 'PLATFORM').ok,
      false,
    );
  });

  it('SEC-CTL-023：selectRetryableItems 只挑出失败项；部分成功汇总保留成功项', () => {
    const retryable = selectRetryableItems(ORIGINAL.frozenItems, ORIGINAL.itemResults);
    assert.deepEqual(
      retryable.map((i) => i.itemId),
      ['b', 'c'],
    );

    const summary = summarizeBatch({
      batchId: 'batch-1',
      frozenItems: ORIGINAL.frozenItems,
      itemResults: ORIGINAL.itemResults,
    });
    assert.equal(summary.status, BatchStatus.PARTIALLY_SUCCEEDED);
    assert.equal(summary.succeeded, 1, '成功项不回滚');
    assert.equal(summary.failed, 2);
    assert.equal(summary.total, 3);
  });
});
