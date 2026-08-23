import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ControlledBatchUseCase, type BatchCompensationItem } from './controlled-batch.use-case';
import type { ControlledBatchPort } from '../ports';

function makePort(): ControlledBatchPort & { executed: string[] } {
  const executed: string[] = [];
  return {
    executed,
    async execute(batchId: string, phase: string) {
      executed.push(`${batchId}:${phase}`);
      return { ok: true };
    },
  } as unknown as ControlledBatchPort & { executed: string[] };
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

  it('空数组：直接返回空轨迹', async () => {
    const useCase = new ControlledBatchUseCase(makePort());
    const r = await useCase.compensateInReverseOrder([]);
    assert.deepEqual(r, { compensated: [], failed: [] });
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
