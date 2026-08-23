/**
 * ExportTaskStateMachine 单测（SRS-SM-EXP-001，IFC-SM-029）。
 *
 * 验收标准：单测覆盖全部合法转换 + 非法转换拒绝。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ExportTaskStateMachine,
  ExportTaskStatus,
  EXPORT_TRANSITION_TABLE,
  TERMINAL_STATUSES,
  IllegalExportTaskTransitionError,
  type ExportTaskEvent,
  type ExportTaskStatus as Status,
} from './export-task.state-machine';

const sm = new ExportTaskStateMachine();

const ALL_STATUSES: readonly Status[] = [
  ExportTaskStatus.NEW,
  ExportTaskStatus.PENDING_GENERATION,
  ExportTaskStatus.GENERATING,
  ExportTaskStatus.DOWNLOADABLE,
  ExportTaskStatus.FAILED,
  ExportTaskStatus.REVOKED,
  ExportTaskStatus.EXPIRED,
  ExportTaskStatus.PRE_DELETED,
];

const ALL_EVENTS: readonly ExportTaskEvent[] = [
  'apply',
  'start_generation',
  'generation_succeeded',
  'generation_failed',
  'retry_generation',
  'revoke',
  'download',
  'expire',
  'pre_delete',
  'formal_delete_hit',
];

/** 断言非法转换抛 IFC-ERR-007 状态冲突 */
function assertIllegal(from: Status, event: ExportTaskEvent): void {
  assert.throws(
    () => sm.transition(from, event),
    (e: IllegalExportTaskTransitionError) => e.message.includes('IFC-ERR-007'),
    `应拒绝 ${from} --${event}-->`,
  );
}

// ===========================================================================
// 1. 转换表结构
// ===========================================================================

describe('ExportTaskStateMachine — 转换表结构', () => {
  it('TABLE：每个事件声明了允许的源状态（SRS-SM-EXP-001 §10.3）', () => {
    assert.deepEqual(EXPORT_TRANSITION_TABLE.apply, [ExportTaskStatus.NEW]);
    assert.deepEqual(EXPORT_TRANSITION_TABLE.start_generation, [
      ExportTaskStatus.PENDING_GENERATION,
    ]);
    assert.deepEqual(EXPORT_TRANSITION_TABLE.generation_succeeded, [ExportTaskStatus.GENERATING]);
    assert.deepEqual(EXPORT_TRANSITION_TABLE.generation_failed, [ExportTaskStatus.GENERATING]);
    assert.deepEqual(EXPORT_TRANSITION_TABLE.retry_generation, [ExportTaskStatus.FAILED]);
    assert.deepEqual(
      [...EXPORT_TRANSITION_TABLE.revoke].sort(),
      [
        ExportTaskStatus.PENDING_GENERATION,
        ExportTaskStatus.GENERATING,
        ExportTaskStatus.DOWNLOADABLE,
      ].sort(),
    );
    assert.deepEqual(EXPORT_TRANSITION_TABLE.download, [ExportTaskStatus.DOWNLOADABLE]);
    assert.deepEqual(
      [...EXPORT_TRANSITION_TABLE.expire].sort(),
      [
        ExportTaskStatus.PENDING_GENERATION,
        ExportTaskStatus.GENERATING,
        ExportTaskStatus.DOWNLOADABLE,
      ].sort(),
    );
    assert.deepEqual(
      [...EXPORT_TRANSITION_TABLE.pre_delete].sort(),
      [
        ExportTaskStatus.PENDING_GENERATION,
        ExportTaskStatus.FAILED,
        ExportTaskStatus.DOWNLOADABLE,
      ].sort(),
    );
    // 正式删除命中：任一非删除状态（不含 PRE_DELETED 本身）
    assert.ok(!EXPORT_TRANSITION_TABLE.formal_delete_hit.includes(ExportTaskStatus.PRE_DELETED));
    for (const s of ALL_STATUSES) {
      if (s === ExportTaskStatus.PRE_DELETED) continue;
      assert.ok(
        EXPORT_TRANSITION_TABLE.formal_delete_hit.includes(s),
        `formal_delete_hit 应允许源状态 ${s}`,
      );
    }
  });

  it('TABLE：每个事件的目标状态合法', () => {
    // 事件目标不得为源状态（download 自环除外）
    assert.equal(sm.transition(ExportTaskStatus.NEW, 'apply'), ExportTaskStatus.PENDING_GENERATION);
    assert.equal(
      sm.transition(ExportTaskStatus.PENDING_GENERATION, 'start_generation'),
      ExportTaskStatus.GENERATING,
    );
    assert.equal(
      sm.transition(ExportTaskStatus.GENERATING, 'generation_succeeded'),
      ExportTaskStatus.DOWNLOADABLE,
    );
    assert.equal(
      sm.transition(ExportTaskStatus.GENERATING, 'generation_failed'),
      ExportTaskStatus.FAILED,
    );
  });
});

// ===========================================================================
// 2. 全部合法转换
// ===========================================================================

describe('ExportTaskStateMachine — 合法转换（SRS-SM-EXP-001 10 条）', () => {
  it('转换 1：NEW --apply--> PENDING_GENERATION', () => {
    assert.equal(sm.transition(ExportTaskStatus.NEW, 'apply'), ExportTaskStatus.PENDING_GENERATION);
  });

  it('转换 2：PENDING_GENERATION --start_generation--> GENERATING', () => {
    assert.equal(
      sm.transition(ExportTaskStatus.PENDING_GENERATION, 'start_generation'),
      ExportTaskStatus.GENERATING,
    );
  });

  it('转换 3：GENERATING --generation_succeeded--> DOWNLOADABLE', () => {
    assert.equal(
      sm.transition(ExportTaskStatus.GENERATING, 'generation_succeeded'),
      ExportTaskStatus.DOWNLOADABLE,
    );
  });

  it('转换 4：GENERATING --generation_failed--> FAILED', () => {
    assert.equal(
      sm.transition(ExportTaskStatus.GENERATING, 'generation_failed'),
      ExportTaskStatus.FAILED,
    );
  });

  it('转换 5a：FAILED --retry_generation--> PENDING_GENERATION（默认）', () => {
    assert.equal(
      sm.transition(ExportTaskStatus.FAILED, 'retry_generation'),
      ExportTaskStatus.PENDING_GENERATION,
    );
  });

  it('转换 5b：FAILED --retry_generation--> GENERATING（显式立即重试）', () => {
    assert.equal(
      sm.transition(ExportTaskStatus.FAILED, 'retry_generation', {
        target: ExportTaskStatus.GENERATING,
      }),
      ExportTaskStatus.GENERATING,
    );
  });

  it('转换 6：待生成/生成中/可下载 --revoke--> REVOKED', () => {
    for (const from of EXPORT_TRANSITION_TABLE.revoke) {
      assert.equal(sm.transition(from, 'revoke'), ExportTaskStatus.REVOKED, `${from} 可失权`);
    }
  });

  it('转换 7：DOWNLOADABLE --download--> DOWNLOADABLE（自环，只记下载不改状态）', () => {
    assert.equal(
      sm.transition(ExportTaskStatus.DOWNLOADABLE, 'download'),
      ExportTaskStatus.DOWNLOADABLE,
    );
    assert.ok(sm.canDownload(ExportTaskStatus.DOWNLOADABLE));
  });

  it('转换 8：待生成/生成中/可下载 --expire--> EXPIRED', () => {
    for (const from of EXPORT_TRANSITION_TABLE.expire) {
      assert.equal(sm.transition(from, 'expire'), ExportTaskStatus.EXPIRED, `${from} 可过期`);
    }
  });

  it('转换 9：待生成/失败/可下载 --pre_delete--> PRE_DELETED', () => {
    for (const from of EXPORT_TRANSITION_TABLE.pre_delete) {
      assert.equal(
        sm.transition(from, 'pre_delete'),
        ExportTaskStatus.PRE_DELETED,
        `${from} 可提前删除`,
      );
    }
  });

  it('转换 10：任一非删除状态 --formal_delete_hit--> PRE_DELETED（AUD-009 不可绕删）', () => {
    for (const from of ALL_STATUSES) {
      if (from === ExportTaskStatus.PRE_DELETED) continue;
      assert.equal(
        sm.transition(from, 'formal_delete_hit'),
        ExportTaskStatus.PRE_DELETED,
        `${from} 命中正式删除清单应转 PRE_DELETED`,
      );
    }
  });
});

// ===========================================================================
// 3. 非法转换拒绝（全量穷举）
// ===========================================================================

describe('ExportTaskStateMachine — 非法转换拒绝（IFC-ERR-007）', () => {
  it('穷举：每个事件 × 不在允许源列表的状态都必须拒绝', () => {
    for (const event of ALL_EVENTS) {
      for (const from of ALL_STATUSES) {
        const allowed = EXPORT_TRANSITION_TABLE[event].includes(from);
        if (allowed) continue;
        assertIllegal(from, event);
      }
    }
  });

  it('典型非法用例：已接受流转不可逆', () => {
    // 终态不可继续生成/下载/重试
    assertIllegal(ExportTaskStatus.REVOKED, 'start_generation');
    assertIllegal(ExportTaskStatus.REVOKED, 'download');
    assertIllegal(ExportTaskStatus.EXPIRED, 'download');
    assertIllegal(ExportTaskStatus.PRE_DELETED, 'retry_generation');
    assertIllegal(ExportTaskStatus.PRE_DELETED, 'expire');
    // NEW 不能直接生成/下载/删除
    assertIllegal(ExportTaskStatus.NEW, 'start_generation');
    assertIllegal(ExportTaskStatus.NEW, 'download');
    assertIllegal(ExportTaskStatus.NEW, 'expire');
    // DOWNLOADABLE 不能再启动生成
    assertIllegal(ExportTaskStatus.DOWNLOADABLE, 'start_generation');
    assertIllegal(ExportTaskStatus.DOWNLOADABLE, 'generation_succeeded');
    // 生成中不能重复成功/失败之外的事件
    assertIllegal(ExportTaskStatus.GENERATING, 'apply');
    assertIllegal(ExportTaskStatus.GENERATING, 'download');
    // 失败不能直接成功
    assertIllegal(ExportTaskStatus.FAILED, 'generation_succeeded');
    assertIllegal(ExportTaskStatus.FAILED, 'download');
    // 已删除状态不可重复删除
    assertIllegal(ExportTaskStatus.PRE_DELETED, 'formal_delete_hit');
    assertIllegal(ExportTaskStatus.PRE_DELETED, 'pre_delete');
  });

  it('download 仅 DOWNLOADABLE 允许（其余状态一律拒绝）', () => {
    for (const from of ALL_STATUSES) {
      if (from === ExportTaskStatus.DOWNLOADABLE) continue;
      assertIllegal(from, 'download');
      assert.equal(sm.canDownload(from), false);
    }
  });

  it('retry_generation 目标非法 → 拒绝', () => {
    assert.throws(
      () =>
        sm.transition(ExportTaskStatus.FAILED, 'retry_generation', {
          target: ExportTaskStatus.REVOKED,
        }),
      (e: IllegalExportTaskTransitionError) => e.message.includes('IFC-ERR-005'),
      '重试目标仅允许 PENDING_GENERATION / GENERATING',
    );
    assert.throws(
      () =>
        sm.transition(ExportTaskStatus.FAILED, 'retry_generation', {
          target: ExportTaskStatus.DOWNLOADABLE,
        }),
      (e: IllegalExportTaskTransitionError) => e.message.includes('IFC-ERR-005'),
    );
  });
});

// ===========================================================================
// 4. 终态判定
// ===========================================================================

describe('ExportTaskStateMachine — 终态判定', () => {
  it('失权/过期/提前删除为终态', () => {
    for (const s of TERMINAL_STATUSES) {
      assert.ok(sm.isTerminal(s), `${s} 应为终态`);
    }
  });

  it('失败可重试、可下载可撤销，均非终态', () => {
    assert.equal(sm.isTerminal(ExportTaskStatus.FAILED), false);
    assert.equal(sm.isTerminal(ExportTaskStatus.DOWNLOADABLE), false);
    assert.equal(sm.isTerminal(ExportTaskStatus.NEW), false);
    assert.equal(sm.isTerminal(ExportTaskStatus.PENDING_GENERATION), false);
    assert.equal(sm.isTerminal(ExportTaskStatus.GENERATING), false);
  });
});

// ===========================================================================
// 5. 主链路回归（状态机级）
// ===========================================================================

describe('ExportTaskStateMachine — 主链路回归', () => {
  it('成功链路：申请 → 生成 → 可下载', () => {
    let s: Status = ExportTaskStatus.NEW;
    s = sm.transition(s, 'apply');
    s = sm.transition(s, 'start_generation');
    s = sm.transition(s, 'generation_succeeded');
    assert.equal(s, ExportTaskStatus.DOWNLOADABLE);
    assert.ok(sm.canDownload(s));
  });

  it('失败重试链路：生成失败 → 重试 → 再次失败', () => {
    let s: Status = ExportTaskStatus.NEW;
    s = sm.transition(s, 'apply');
    s = sm.transition(s, 'start_generation');
    s = sm.transition(s, 'generation_failed');
    assert.equal(s, ExportTaskStatus.FAILED);
    s = sm.transition(s, 'retry_generation');
    assert.equal(s, ExportTaskStatus.PENDING_GENERATION);
    s = sm.transition(s, 'start_generation');
    s = sm.transition(s, 'generation_failed');
    assert.equal(s, ExportTaskStatus.FAILED, '重试沿用原快照可再次失败');
  });

  it('失权链路：可下载状态被失权后不可下载', () => {
    let s: Status = ExportTaskStatus.NEW;
    s = sm.transition(s, 'apply');
    s = sm.transition(s, 'start_generation');
    s = sm.transition(s, 'generation_succeeded');
    s = sm.transition(s, 'revoke');
    assert.equal(s, ExportTaskStatus.REVOKED);
    assert.equal(sm.canDownload(s), false);
    assertIllegal(s, 'download');
  });

  it('正式删除命中不可绕删：已过期任务仍被删除清单清理', () => {
    let s: Status = ExportTaskStatus.NEW;
    s = sm.transition(s, 'apply');
    s = sm.transition(s, 'expire');
    assert.equal(s, ExportTaskStatus.EXPIRED);
    s = sm.transition(s, 'formal_delete_hit');
    assert.equal(s, ExportTaskStatus.PRE_DELETED);
  });
});
