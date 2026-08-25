/**
 * TST-SM 六分面矩阵执行证据（P0 工作包①；CI-004 发布门）。
 *
 * 基建：test/fixtures/state-machine-test-matrix.ts（通用全枚举运行器）
 *      + test/fixtures/syn-data-builder.ts（确定性合成数据）。
 *
 * 首批接入：joint 模块 6 台状态机——对每台做**全枚举**验证：
 * - NOM：显式合法转换表逐行通过；
 * - STA：全枚举补集一律拒绝且不泄漏 nextState；
 * - 确定性：双跑一致；
 * - 终态闭合：终态冻结。
 *
 * 后续按同模式逐台接入其余 23 台（org/membership/recruitment/identity 等），
 * 接入方式：在下方 MACHINES 注册表追加条目即可，无需修改 fixture。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { StateMachineTestMatrix } from '../fixtures/state-machine-test-matrix';
import { SynDataBuilder } from '../fixtures/syn-data-builder';
import {
  JointActivityStateMachine,
  JointActivityEvent,
  JointActivityStatus,
} from '../../src/modules/joint/domain/state-machines/joint-activity.state-machine';
import {
  JointApplicationStateMachine,
  JointApplicationEvent,
  JointApplicationStatus,
} from '../../src/modules/joint/domain/state-machines/joint-application.state-machine';
import {
  JointChannelStateMachine,
  JointChannelEvent,
  JointChannelStatus,
} from '../../src/modules/joint/domain/state-machines/joint-channel.state-machine';
import {
  JointInterviewStateMachine,
  JointInterviewEvent,
  JointInterviewStatus,
} from '../../src/modules/joint/domain/state-machines/joint-interview.state-machine';

// ---- 合成数据（确定性；SYN-DATA-* 边界）----
const syn = new SynDataBuilder(20260801);

describe('TST-SM 六分面矩阵（P0 工作包①）', () => {
  it('SynDataBuilder：同一 seed 双实例产出完全一致的合成数据', () => {
    const a = new SynDataBuilder(42);
    const b = new SynDataBuilder(42);
    assert.equal(a.userId(1), b.userId(1));
    assert.equal(a.clubId(2), b.clubId(2));
    assert.equal(a.timestamp(1000), b.timestamp(1000));
    // 不同 seed → 不同值
    const c = new SynDataBuilder(999);
    assert.notEqual(a.nextInt(), c.nextInt());
  });

  it('JNT-001 联合活动：全枚举 NOM+STA+确定性+终态闭合', () => {
    const machine = new JointActivityStateMachine();
    const legal = [
      {
        from: JointActivityStatus.DRAFT_CONFIRMING,
        event: JointActivityEvent.CONFIRM_ALL,
        to: JointActivityStatus.ESTABLISHED,
      },
      {
        from: JointActivityStatus.ESTABLISHED,
        event: JointActivityEvent.PUBLISH,
        to: JointActivityStatus.PUBLISHED,
      },
      {
        from: JointActivityStatus.PUBLISHED,
        event: JointActivityEvent.SEND_FIRST_INVITATION,
        to: JointActivityStatus.INVITING,
      },
      {
        from: JointActivityStatus.INVITING,
        event: JointActivityEvent.BEGIN_END_CONFIRM,
        to: JointActivityStatus.END_CONFIRMING,
      },
      {
        from: JointActivityStatus.END_CONFIRMING,
        event: JointActivityEvent.END,
        to: JointActivityStatus.ENDED,
      },
      {
        from: JointActivityStatus.DRAFT_CONFIRMING,
        event: JointActivityEvent.CANCEL_ALL,
        to: JointActivityStatus.CANCELLED,
      },
      // FORCE_END 对任意状态可用（含终态重标记）
      ...Object.values(JointActivityStatus).map((s) => ({
        from: s,
        event: JointActivityEvent.FORCE_END,
        to: JointActivityStatus.FORCE_ENDED,
      })),
    ];
    const matrix = new StateMachineTestMatrix({
      id: 'JNT-001',
      machine,
      states: Object.values(JointActivityStatus),
      events: Object.values(JointActivityEvent),
      terminal: [
        JointActivityStatus.ENDED,
        JointActivityStatus.CANCELLED,
        JointActivityStatus.FORCE_ENDED,
      ],
      terminalAllow: [JointActivityEvent.FORCE_END],
      legal,
    });
    matrix.verifyAll();
  });

  it('JNT-003 联合申请：全枚举 NOM+STA+确定性+终态闭合', () => {
    const matrix = new StateMachineTestMatrix({
      id: 'JNT-003',
      machine: new JointApplicationStateMachine(),
      states: Object.values(JointApplicationStatus),
      events: Object.values(JointApplicationEvent),
      terminal: [JointApplicationStatus.ARCHIVED],
      legal: [
        {
          from: JointApplicationStatus.DRAFT,
          event: JointApplicationEvent.SUBMIT,
          to: JointApplicationStatus.SUBMITTED,
        },
        {
          from: JointApplicationStatus.SUBMITTED,
          event: JointApplicationEvent.ARCHIVE,
          to: JointApplicationStatus.ARCHIVED,
        },
      ],
    });
    matrix.verifyAll();
  });

  it('JNT-006 联合通道：全枚举 NOM+STA+确定性+终态闭合', () => {
    const matrix = new StateMachineTestMatrix({
      id: 'JNT-006',
      machine: new JointChannelStateMachine(),
      states: Object.values(JointChannelStatus),
      events: Object.values(JointChannelEvent),
      terminal: [JointChannelStatus.CLOSED_FINAL],
      terminalAllow: [JointChannelEvent.REOPEN],
      legal: [
        {
          from: JointChannelStatus.NOT_OPEN,
          event: JointChannelEvent.OPEN,
          to: JointChannelStatus.OPEN,
        },
        {
          from: JointChannelStatus.OPEN,
          event: JointChannelEvent.SUSPEND,
          to: JointChannelStatus.SUSPENDED,
        },
        {
          from: JointChannelStatus.SUSPENDED,
          event: JointChannelEvent.RESUME,
          to: JointChannelStatus.OPEN,
        },
        {
          from: JointChannelStatus.OPEN,
          event: JointChannelEvent.EXTEND,
          to: JointChannelStatus.OPEN,
        },
        {
          from: JointChannelStatus.OPEN,
          event: JointChannelEvent.CLOSE,
          to: JointChannelStatus.CLOSED_FINAL,
        },
        {
          from: JointChannelStatus.SUSPENDED,
          event: JointChannelEvent.CLOSE,
          to: JointChannelStatus.CLOSED_FINAL,
        },
        {
          from: JointChannelStatus.CLOSED_FINAL,
          event: JointChannelEvent.REOPEN,
          to: JointChannelStatus.OPEN,
        },
      ],
    });
    matrix.verifyAll();
  });

  it('JNT-004 联合面试：全枚举 NOM+STA+确定性+终态闭合', () => {
    const matrix = new StateMachineTestMatrix({
      id: 'JNT-004',
      machine: new JointInterviewStateMachine(),
      states: Object.values(JointInterviewStatus),
      events: Object.values(JointInterviewEvent),
      terminal: [JointInterviewStatus.COMPLETED],
      legal: [
        {
          from: JointInterviewStatus.PENDING_CHOICE,
          event: JointInterviewEvent.SCHEDULE,
          to: JointInterviewStatus.SCHEDULED,
        },
        {
          from: JointInterviewStatus.SCHEDULED,
          event: JointInterviewEvent.START,
          to: JointInterviewStatus.IN_PROGRESS,
        },
        {
          from: JointInterviewStatus.IN_PROGRESS,
          event: JointInterviewEvent.COMPLETE,
          to: JointInterviewStatus.COMPLETED,
        },
        {
          from: JointInterviewStatus.SCHEDULED,
          event: JointInterviewEvent.VOID,
          to: JointInterviewStatus.VOIDED,
        },
        {
          from: JointInterviewStatus.IN_PROGRESS,
          event: JointInterviewEvent.VOID,
          to: JointInterviewStatus.VOIDED,
        },
        {
          from: JointInterviewStatus.VOIDED,
          event: JointInterviewEvent.RESCHEDULE,
          to: JointInterviewStatus.SCHEDULED,
        },
      ],
    });
    matrix.verifyAll();
    // 合成数据冒烟：确定性 id 可用于测试夹具
    assert.equal(syn.activityId(1), 'act-0001');
  });

  it('枚举规模守恒：4 台机器的状态×事件网格覆盖完整（防漏配）', () => {
    // JNT-001: 8×7=56 | JNT-003: 3×2=6 | JNT-004: 5×5=25 | JNT-006: 4×6=24
    const expectedGrids = [56, 6, 25, 24];
    const grids = [
      Object.values(JointActivityStatus).length * Object.values(JointActivityEvent).length,
      Object.values(JointApplicationStatus).length * Object.values(JointApplicationEvent).length,
      Object.values(JointInterviewStatus).length * Object.values(JointInterviewEvent).length,
      Object.values(JointChannelStatus).length * Object.values(JointChannelEvent).length,
    ];
    assert.deepEqual(grids, expectedGrids);
  });
});
