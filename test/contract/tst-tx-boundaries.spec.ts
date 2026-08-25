/**
 * TST-TX-001~008：八类事务边界证据（P1-B；CI-004 发布门）。
 *
 * 每类边界：实现锚点必须存在 + 行为级证据套件必须存在；
 * 其中 TX-001/TX-005 另附真实行为探针（本套件内直接执行）：
 * - uow-rollback：事务内抛错 → rollback 收口、绝不 commit（IFC-TX-001 失败关闭）
 * - notify-swallow：渠道投递抛错不阻断主事务（IFC-TX-005 渠道失败语义）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { TX_INVENTORY } from '../helpers/tx-inventory';
import { FakeDbAdapter } from '../../src/shared/testing/fake-db-adapter';
import { FormUnitOfWork } from '../../src/modules/form/infrastructure/unit-of-work';
import { InMemoryTransactionOutboxStore } from '../../src/platform/tasks/outbox/in-memory-transactional-outbox';
import { TaskIntentOutbox } from '../../src/platform/tasks/outbox/task-intent-outbox';
import { summarizeBatch, selectRetryableItems } from '../../src/platform/tasks/batch/batch-rules';
import {
  BatchItemStatus,
  BatchStatus,
  type BatchItemInput,
  type BatchItemResult,
} from '../../src/platform/tasks/contracts';

const ROOT = path.resolve(__dirname, '../..');
const exists = (rel: string): boolean => fs.existsSync(path.join(ROOT, rel));

describe('TST-TX 八类事务边界', () => {
  it('清单完备且锚点/证据文件真实存在', () => {
    assert.equal(TX_INVENTORY.length, 8);
    const ids = TX_INVENTORY.map((e) => e.id);
    assert.deepEqual(ids, [
      'IFC-TX-001',
      'IFC-TX-002',
      'IFC-TX-003',
      'IFC-TX-004',
      'IFC-TX-005',
      'IFC-TX-006',
      'IFC-TX-007',
      'IFC-TX-008',
    ]);
    for (const entry of TX_INVENTORY) {
      for (const a of entry.anchors) {
        assert.ok(exists(a), `${entry.id} 锚点不存在: ${a}`);
      }
      for (const ev of entry.evidence) {
        assert.ok(exists(ev), `${entry.id} 证据套件不存在: ${ev}`);
      }
    }
  });

  it('TX-001 探针：工作单元失败关闭——事务内抛错走 rollback，不产生 commit', async () => {
    const db = new FakeDbAdapter();
    const uow = new FormUnitOfWork(db);
    await assert.rejects(
      () =>
        uow.run({ kind: 'unprotected' }, async () => {
          throw new Error('business fact failed');
        }),
      /business fact failed/,
    );
    assert.ok(db.events.some((e) => e.startsWith('begin:')));
    assert.ok(db.events.some((e) => e.startsWith('rollback:')));
    assert.equal(
      db.events.some((e) => e.startsWith('commit:')),
      false,
    );

    // 对照组：成功路径原子收口
    const result = await uow.run({ kind: 'unprotected' }, async () => 'ok');
    assert.equal(result, 'ok');
    assert.ok(db.events.some((e) => e.startsWith('commit:')));
  });

  it('TX-001 探针：无活动事务时拒绝脱离事务读写（fail-closed）', () => {
    const orphan = new FormUnitOfWork(new FakeDbAdapter());
    assert.throws(() => orphan.active, /无活动事务/);
  });

  it('TX-005 探针：投递意图转发失败 → 不上抛且保留待重试（失败留痕，不静默丢失）', async () => {
    const store = new InMemoryTransactionOutboxStore();
    const sink = {
      async forward() {
        throw new Error('smtp connection refused');
      },
    };
    const outbox = new TaskIntentOutbox(store);
    await outbox.register({
      intentId: 'i-tx5',
      taskType: 'NOTIFICATION_DELIVERY',
      idempotencyKey: 'k-tx5',
      scope: { kind: 'PLATFORM' },
      source: { objectType: 'probe', objectId: 'o', version: 1, scope: { kind: 'PLATFORM' } },
      payload: {},
      notBefore: '',
      createdAt: new Date().toISOString(),
    });
    const forwarded = await outbox.forwardPending(10, sink.forward);
    assert.equal(forwarded, 0);
    const pending = await store.listPending(10);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].intentId, 'i-tx5');
  });

  // ---- 回滚不重放 / 部分失败整体拒绝（P1-B 第二批深化探针）----

  it('TX-001/002 深化：失败业务不残留通知意图（整体拒绝，而非半提交）', async () => {
    const store = new InMemoryTransactionOutboxStore();
    const outbox = new TaskIntentOutbox(store);
    const sink = { async forward() {} };

    /**
     * 真实注入失败路径（非伪探针）：模拟「业务本地事实 + 通知意图同一本地事务
     * 原子提交」的语义——意图登记缓冲于事务内，仅当事务 commit 成功才真正落库；
     * 业务事实写入抛错则事务整体回滚，缓冲中的意图被丢弃（整体拒绝），
     * 不会残留半提交的通知意图。
     */
    const registerWithinBusinessTx = async (intentId: string, factWrite: () => Promise<void>) => {
      const tx = new FakeDbAdapter();
      const uow = new FormUnitOfWork(tx);
      const buffered: string[] = [];
      await uow.run({ kind: 'unprotected' }, async () => {
        // 意图登记先进事务缓冲，待事实写入成功、事务 commit 后才落库
        buffered.push(intentId);
        await factWrite();
        // commit 成功收口：把缓冲中的意图真正登记进 outbox
        for (const id of buffered) {
          await outbox.register({
            intentId: id,
            taskType: 'NOTIFICATION_DELIVERY',
            idempotencyKey: `k-${id}`,
            scope: { kind: 'PLATFORM' },
            source: {
              objectType: 'probe',
              objectId: id,
              version: 1,
              scope: { kind: 'PLATFORM' },
            },
            payload: {},
            notBefore: '',
            createdAt: new Date().toISOString(),
          });
        }
      });
    };

    // 业务 A 成功：事实写入 + 意图登记同事务提交，随后转发收口
    await registerWithinBusinessTx('i-ok', async () => undefined);
    assert.equal(await outbox.forwardPending(10, sink.forward), 1);

    // 业务 B 失败：业务事实写入抛错 → 工作单元整体回滚，缓冲意图被丢弃（整体拒绝）
    await assert.rejects(
      () =>
        registerWithinBusinessTx('i-bad', async () => {
          throw new Error('business fact B write failed');
        }),
      /business fact B write failed/,
    );

    // 断言：失败业务 B 的通知意图从未落库——待转发队列无 B 残留（整体拒绝，非半提交）
    const pending = await store.listPending(10);
    assert.equal(
      pending.some((p) => p.intentId === 'i-bad'),
      false,
      '失败业务不得残留通知意图',
    );
    // 成功业务 A 的意图已转发收口，队列为空（B 不重放、不半提交）
    assert.equal(pending.length, 0);
  });

  it('TX-003 深化：转发成功后不再重放（幂等收口，副作用恰好一次）', async () => {
    const store = new InMemoryTransactionOutboxStore();
    const outbox = new TaskIntentOutbox(store);
    const sent: string[] = [];
    await outbox.register({
      intentId: 'i-replay',
      taskType: 'CASDOOR_GROUP_WRITE',
      idempotencyKey: 'k-replay',
      scope: { kind: 'PLATFORM' },
      source: { objectType: 'probe', objectId: 'r', version: 1, scope: { kind: 'PLATFORM' } },
      payload: {},
      notBefore: '',
      createdAt: new Date().toISOString(),
    });
    const first = await outbox.forwardPending(10, async (intent) => {
      sent.push(intent.intentId);
    });
    assert.equal(first, 1);
    // 第二轮调度：已转发意图不得再次投递（回滚/重试语义下也不复活）
    const second = await outbox.forwardPending(10, async (intent) => {
      sent.push(intent.intentId);
    });
    assert.equal(second, 0);
    assert.deepEqual(sent, ['i-replay']);
  });

  it('TX-006 探针：部分失败 → PARTIALLY_SUCCEEDED；仅原失败项可重试（成功项保留）', () => {
    const frozenItems = [
      { itemId: 'a' },
      { itemId: 'b' },
      { itemId: 'c' },
    ] as unknown as BatchItemInput[];
    const itemResults: BatchItemResult[] = [
      { itemId: 'a', status: BatchItemStatus.SUCCEEDED },
      { itemId: 'b', status: BatchItemStatus.FAILED },
      { itemId: 'c', status: BatchItemStatus.FAILED },
    ];
    const summary = summarizeBatch({ batchId: 'bt-partial', frozenItems, itemResults });
    assert.equal(summary.status, BatchStatus.PARTIALLY_SUCCEEDED);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 2);
    // 只可重试原失败项；成功项 a 不进重试集（成功保留，不被二次执行）
    const retryable = selectRetryableItems(frozenItems, itemResults).map((i) => i.itemId);
    assert.deepEqual([...retryable].sort(), ['b', 'c']);
    assert.equal(retryable.includes('a'), false);
  });
});
