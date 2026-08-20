import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ControlledBatchStateMachine,
  deriveBatchTerminal,
  type BatchTransitionInput,
} from './controlled-batch.state-machine';

function run(
  event: BatchTransitionInput['event'],
  status: BatchTransitionInput['status'],
  facts?: BatchTransitionInput['facts'],
) {
  return new ControlledBatchStateMachine().transition({ status, event, facts: facts ?? {} });
}

describe('ControlledBatchStateMachine', () => {
  it('generate_preview：须固定作用域（一个社团/操作/业务类型）', () => {
    assert.throws(
      () => run('generate_preview', 'selecting', { scopeFixed: false }),
      (e: Error) => e.message.includes('固定'),
    );
    const r = run('generate_preview', 'selecting', { scopeFixed: true });
    assert.equal(r.status, 'previewed_pending_confirm');
    assert.ok(r.requiredSideEffects.includes('freeze_filter_snapshot'));
  });

  it('confirm_execute：预览须新鲜且输入已冻结才执行', () => {
    assert.throws(
      () => run('confirm_execute', 'previewed_pending_confirm', {}),
      (e: Error) => e.message.includes('预览已过期'),
    );
    const r = run('confirm_execute', 'previewed_pending_confirm', {
      previewFresh: true,
      inputsFrozen: true,
    });
    assert.equal(r.status, 'executing');
    assert.ok(r.requiredSideEffects.includes('freeze_batch_inputs'));
  });

  it('modify_selection：操作者失权不得修改批次', () => {
    assert.throws(
      () => run('modify_selection', 'previewed_pending_confirm', { operatorAuthorized: false }),
      (e: Error) => e.message.includes('失权'),
    );
  });

  it('单项结果仅执行中收口', () => {
    assert.throws(
      () => run('item_succeeded', 'previewed_pending_confirm'),
      (e: Error) => e.message.includes('不允许执行'),
    );
    const r = run('item_succeeded', 'executing', { items: [{ itemId: 'i1', result: 'success' }] });
    assert.equal(r.status, 'executing');
  });

  it('all_items_finished：按单项结果派生终态', () => {
    const r = run('all_items_finished', 'executing', {
      items: [
        { itemId: 'i1', result: 'success' },
        { itemId: 'i2', result: 'failure' },
      ],
    });
    assert.equal(r.status, 'partial_success');
  });

  it('deriveBatchTerminal：全部成功/全部失败/部分成功', () => {
    assert.equal(deriveBatchTerminal([{ itemId: 'a', result: 'success' }]), 'all_succeeded');
    assert.equal(deriveBatchTerminal([{ itemId: 'a', result: 'failure' }]), 'all_failed');
    assert.equal(
      deriveBatchTerminal([
        { itemId: 'a', result: 'success' },
        { itemId: 'b', result: 'failure' },
      ]),
      'partial_success',
    );
  });

  it('retry_failed_items：无失败项拒绝；重试仅限失败项、沿用原幂等键', () => {
    assert.throws(
      () => run('retry_failed_items', 'partial_success', { items: [] }),
      (e: Error) => e.message.includes('无失败项'),
    );
    const r = run('retry_failed_items', 'partial_success', {
      items: [
        { itemId: 'a', result: 'success' },
        { itemId: 'b', result: 'failure' },
      ],
    });
    assert.equal(r.status, 'failed_items_retrying');
    assert.ok(r.requiredSideEffects.includes('link_original_batch'));
  });

  it('retry_items_finished：合并成功不重复回滚已成功项', () => {
    const r = run('retry_items_finished', 'failed_items_retrying', {
      retryItems: [{ itemId: 'b', result: 'success' }],
    });
    assert.equal(r.status, 'all_succeeded');
    assert.ok(r.requiredSideEffects.includes('monotonic_success_union'));
  });
});
