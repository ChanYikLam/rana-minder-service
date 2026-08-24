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
});
