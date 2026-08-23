import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ControlledBatchUseCase, type BatchCompensationItem } from './controlled-batch.use-case';
import type { ControlledBatchPort } from '../ports';

function makePort(): ControlledBatchPort & { executed: string[]; lastEffects?: readonly string[] } {
  const executed: string[] = [];
  let lastEffects: readonly string[] | undefined;
  return {
    get executed() {
      return executed;
    },
    get lastEffects() {
      return lastEffects;
    },
    async execute(batchId: string, phase: string, requiredSideEffects?: readonly string[]) {
      executed.push(`${batchId}:${phase}`);
      lastEffects = requiredSideEffects;
      return { ok: true };
    },
  } as unknown as ControlledBatchPort & {
    executed: string[];
    lastEffects?: readonly string[];
  };
}

// -------------------------------------------------------------------------
// drive：状态机阶段驱动
// -------------------------------------------------------------------------

describe('ControlledBatchUseCase.drive', () => {
  it('仅放行 8 条已知事件，未知事件拒绝', async () => {
    const port = makePort();
    const useCase = new ControlledBatchUseCase(port);
    await assert.rejects(
      () =>
        useCase.drive({
          batchId: 'b1',
          event: 'unknown_event' as never,
          status: 'selecting',
          facts: {},
        }),
      (e: Error) => e.message.includes('未知批次事件'),
    );
  });

  it('合法事件：generate_preview 后返回 previewed_pending_confirm', async () => {
    const port = makePort();
    const useCase = new ControlledBatchUseCase(port);
    const next = await useCase.drive({
      batchId: 'b1',
      event: 'generate_preview',
      status: 'selecting',
      facts: { scopeFixed: true },
    });
    assert.equal(next, 'previewed_pending_confirm');
    assert.deepEqual(port.executed, ['b1:generate_preview']);
    // 状态机声明的副作用标签被平台端口消费
    assert.deepEqual(port.lastEffects, ['save_preview_audit', 'freeze_filter_snapshot']);
  });

  it('合法事件：confirm_execute 把副作用标签交给平台端口', async () => {
    const port = makePort();
    const useCase = new ControlledBatchUseCase(port);
    await useCase.drive({
      batchId: 'b1',
      event: 'confirm_execute',
      status: 'previewed_pending_confirm',
      facts: { previewFresh: true, inputsFrozen: true },
    });
    assert.deepEqual(port.lastEffects, [
      'freeze_batch_inputs',
      'spawn_item_tasks',
      'batch_confirm_audit',
    ]);
  });

  it('合法事件：all_items_finished 派生 partial_success', async () => {
    const port = makePort();
    const useCase = new ControlledBatchUseCase(port);
    const next = await useCase.drive({
      batchId: 'b1',
      event: 'all_items_finished',
      status: 'executing',
      facts: {
        items: [
          { itemId: 'i1', result: 'success' },
          { itemId: 'i2', result: 'failure' },
        ],
      },
    });
    assert.equal(next, 'partial_success');
  });
});

// -------------------------------------------------------------------------
// compensateInReverseOrder：批次部分成功逆序补偿（ORG-034 关联）
// -------------------------------------------------------------------------

describe('ControlledBatchUseCase.compensateInReverseOrder（ORG-034 逆序补偿）', () => {
  it('按 stepOrder 降序补偿（执行顺序中靠后的先撤销）', async () => {
    const order: string[] = [];
    const items: BatchCompensationItem[] = [
      {
        itemId: 'i1',
        stepOrder: 1,
        compensate: async () => {
          order.push('i1');
        },
      },
      {
        itemId: 'i2',
        stepOrder: 2,
        compensate: async () => {
          order.push('i2');
        },
      },
      {
        itemId: 'i3',
        stepOrder: 3,
        compensate: async () => {
          order.push('i3');
        },
      },
    ];
    const useCase = new ControlledBatchUseCase(makePort());
    const r = await useCase.compensateInReverseOrder(items);
    // 逆序：i3 → i2 → i1
    assert.deepEqual(order, ['i3', 'i2', 'i1']);
    assert.deepEqual(r.compensated, ['i3', 'i2', 'i1']);
    assert.deepEqual(r.failed, []);
  });

  it('空数组：直接返回空轨迹（fullyCompensated=true）', async () => {
    const useCase = new ControlledBatchUseCase(makePort());
    const r = await useCase.compensateInReverseOrder([]);
    assert.deepEqual(r, { compensated: [], failed: [], fullyCompensated: true });
  });

  it('单项补偿失败不阻断后续补偿（继续回退到最早项以缩小影响面）', async () => {
    const order: string[] = [];
    const items: BatchCompensationItem[] = [
      {
        itemId: 'i1',
        stepOrder: 1,
        compensate: async () => {
          order.push('i1');
        },
      },
      {
        itemId: 'i2',
        stepOrder: 2,
        compensate: async () => {
          order.push('i2-throw');
          throw new Error('compensation 502');
        },
      },
      {
        itemId: 'i3',
        stepOrder: 3,
        compensate: async () => {
          order.push('i3');
        },
      },
    ];
    const useCase = new ControlledBatchUseCase(makePort());
    const r = await useCase.compensateInReverseOrder(items);
    // 逆序：i3 → i2(fail) → i1
    assert.deepEqual(order, ['i3', 'i2-throw', 'i1']);
    assert.deepEqual(r.compensated, ['i3', 'i1']);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].itemId, 'i2');
    assert.ok(r.failed[0].error.includes('502'));
  });

  it('逆序结果不修改输入数组（不污染 items 顺序）', async () => {
    const items: BatchCompensationItem[] = [
      { itemId: 'i1', stepOrder: 1, compensate: async () => undefined },
      { itemId: 'i2', stepOrder: 2, compensate: async () => undefined },
      { itemId: 'i3', stepOrder: 3, compensate: async () => undefined },
    ];
    const useCase = new ControlledBatchUseCase(makePort());
    await useCase.compensateInReverseOrder(items);
    // 原数组顺序保持不变
    assert.deepEqual(
      items.map((i) => i.itemId),
      ['i1', 'i2', 'i3'],
    );
  });

  it('非补偿入口状态拒绝（all_succeeded / all_failed 不可补偿，ORG-034）', async () => {
    const useCase = new ControlledBatchUseCase(makePort());
    const items: BatchCompensationItem[] = [
      { itemId: 'i1', stepOrder: 1, compensate: async () => undefined },
    ];
    await assert.rejects(
      () => useCase.compensateInReverseOrder(items, { status: 'all_succeeded' }),
      (e: Error) => e.message.includes('不允许逆序补偿') && e.message.includes('ORG-034'),
    );
    await assert.rejects(
      () => useCase.compensateInReverseOrder(items, { status: 'all_failed' }),
      (e: Error) => e.message.includes('不允许逆序补偿'),
    );
  });

  it('partial_success 状态允许补偿且 fullyCompensated=true', async () => {
    const useCase = new ControlledBatchUseCase(makePort());
    const items: BatchCompensationItem[] = [
      { itemId: 'i1', stepOrder: 1, compensate: async () => undefined },
      { itemId: 'i2', stepOrder: 2, compensate: async () => undefined },
    ];
    const r = await useCase.compensateInReverseOrder(items, { status: 'partial_success' });
    assert.deepEqual(r.compensated, ['i2', 'i1']);
    assert.equal(r.fullyCompensated, true);
  });

  it('stepOrder 重复 → 拒绝逆序（ORG-034 唯一性约束）', async () => {
    const useCase = new ControlledBatchUseCase(makePort());
    const items: BatchCompensationItem[] = [
      { itemId: 'i1', stepOrder: 2, compensate: async () => undefined },
      { itemId: 'i2', stepOrder: 2, compensate: async () => undefined },
    ];
    await assert.rejects(
      () => useCase.compensateInReverseOrder(items),
      (e: Error) => e.message.includes('stepOrder=2 重复') && e.message.includes('ORG-034'),
    );
  });

  it('单项补偿失败 → fullyCompensated=false（供幂等/重试收口决策）', async () => {
    const useCase = new ControlledBatchUseCase(makePort());
    const items: BatchCompensationItem[] = [
      { itemId: 'i1', stepOrder: 1, compensate: async () => undefined },
      {
        itemId: 'i2',
        stepOrder: 2,
        compensate: async () => {
          throw new Error('boom');
        },
      },
    ];
    const r = await useCase.compensateInReverseOrder(items);
    assert.equal(r.fullyCompensated, false);
    assert.deepEqual(r.compensated, ['i1']);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].itemId, 'i2');
  });
});

// -------------------------------------------------------------------------
// assertMaintainsLastOwner：最后负责人连续性守卫（ORG-024）
// -------------------------------------------------------------------------

describe('ControlledBatchUseCase.assertMaintainsLastOwner（ORG-024）', () => {
  it('批次撤销后仍有负责人 → 通过', () => {
    const useCase = new ControlledBatchUseCase(makePort());
    assert.doesNotThrow(() =>
      useCase.assertMaintainsLastOwner({
        clubName: 'ACM社团',
        currentOwnerIds: ['u_a', 'u_b'],
        revokingSubjectIds: ['u_a'],
        successorIds: [],
      }),
    );
  });

  it('批次撤销最后一名负责人未指定继任者 → 拒绝（IFC-ERR-006）', () => {
    const useCase = new ControlledBatchUseCase(makePort());
    assert.throws(
      () =>
        useCase.assertMaintainsLastOwner({
          clubName: 'ACM社团',
          currentOwnerIds: ['u_a'],
          revokingSubjectIds: ['u_a'],
          successorIds: [],
        }),
      (e: Error) =>
        e.message.includes('零负责人窗口') || e.message.includes('必须保留至少一名负责人'),
    );
  });

  it('批次撤销最后一名负责人 + 同一操作指定继任者 → 通过', () => {
    const useCase = new ControlledBatchUseCase(makePort());
    assert.doesNotThrow(() =>
      useCase.assertMaintainsLastOwner({
        clubName: 'ACM社团',
        currentOwnerIds: ['u_a'],
        revokingSubjectIds: ['u_a'],
        successorIds: ['u_b'],
      }),
    );
  });

  it('紧急停用场景 emergencyBypass=true → 允许暂时无负责人（ORG-028 强停豁免）', () => {
    const useCase = new ControlledBatchUseCase(makePort());
    assert.doesNotThrow(() =>
      useCase.assertMaintainsLastOwner({
        clubName: 'ACM社团',
        currentOwnerIds: ['u_a'],
        revokingSubjectIds: ['u_a'],
        successorIds: [],
        emergencyBypass: true,
      }),
    );
  });

  it('紧急停用豁免：原本无负责人也允许（强停前置）', () => {
    const useCase = new ControlledBatchUseCase(makePort());
    assert.doesNotThrow(() =>
      useCase.assertMaintainsLastOwner({
        clubName: 'ACM社团',
        currentOwnerIds: [],
        revokingSubjectIds: [],
        successorIds: [],
        emergencyBypass: true,
      }),
    );
  });

  it('非紧急场景 + 撤销后零负责人 → 拒绝', () => {
    const useCase = new ControlledBatchUseCase(makePort());
    assert.throws(
      () =>
        useCase.assertMaintainsLastOwner({
          clubName: 'ACM社团',
          currentOwnerIds: ['u_a'],
          revokingSubjectIds: ['u_a'],
          successorIds: [],
          emergencyBypass: false,
        }),
      (e: Error) =>
        e.message.includes('零负责人窗口') || e.message.includes('必须保留至少一名负责人'),
    );
  });

  it('批次中无负责人撤销：只校验剩余人数足够', () => {
    const useCase = new ControlledBatchUseCase(makePort());
    // 普通成员撤销不触发继任要求
    assert.doesNotThrow(() =>
      useCase.assertMaintainsLastOwner({
        clubName: 'ACM社团',
        currentOwnerIds: ['u_a'],
        revokingSubjectIds: ['u_c'],
        successorIds: [],
      }),
    );
  });
});
