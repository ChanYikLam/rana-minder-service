/**
 * 联合活动主状态机逐转换测试（JNT-001；SRS-SM-JNT-001；P3 补测）。
 *
 * 主链：草拟确认 → 成立 → 首次公布 → 邀请阶段 → 结束确认 → 已结束；
 * 单向门：首次公布锁定名单、首邀后禁止整体取消；FORCE_END 对任意状态可用。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  JointActivityEvent,
  JointActivityStateMachine,
  JointActivityStatus,
} from './joint-activity.state-machine';

const machine = new JointActivityStateMachine();

function run(event: JointActivityEvent, state: JointActivityStatus) {
  return machine.transition({ event, currentState: state });
}

describe('JointActivityStateMachine（JNT-001）', () => {
  it('主链五段全部允许且次态正确', () => {
    assert.deepEqual(run(JointActivityEvent.CONFIRM_ALL, JointActivityStatus.DRAFT_CONFIRMING), {
      allowed: true,
      nextState: JointActivityStatus.ESTABLISHED,
    });
    assert.deepEqual(run(JointActivityEvent.PUBLISH, JointActivityStatus.ESTABLISHED), {
      allowed: true,
      nextState: JointActivityStatus.PUBLISHED,
    });
    assert.deepEqual(run(JointActivityEvent.SEND_FIRST_INVITATION, JointActivityStatus.PUBLISHED), {
      allowed: true,
      nextState: JointActivityStatus.INVITING,
    });
    assert.deepEqual(run(JointActivityEvent.BEGIN_END_CONFIRM, JointActivityStatus.INVITING), {
      allowed: true,
      nextState: JointActivityStatus.END_CONFIRMING,
    });
    assert.deepEqual(run(JointActivityEvent.END, JointActivityStatus.END_CONFIRMING), {
      allowed: true,
      nextState: JointActivityStatus.ENDED,
    });
  });

  it('取消门：仅 DRAFT_CONFIRMING 可 CANCEL_ALL（首邀前窗口）', () => {
    assert.deepEqual(run(JointActivityEvent.CANCEL_ALL, JointActivityStatus.DRAFT_CONFIRMING), {
      allowed: true,
      nextState: JointActivityStatus.CANCELLED,
    });
    for (const s of [
      JointActivityStatus.ESTABLISHED,
      JointActivityStatus.PUBLISHED,
      JointActivityStatus.INVITING,
      JointActivityStatus.END_CONFIRMING,
    ]) {
      assert.equal(run(JointActivityEvent.CANCEL_ALL, s).allowed, false, `${s} 不应可整体取消`);
    }
  });

  it('强制结束：任意状态（含终态）均可 FORCE_ENDED（超管特权路径）', () => {
    for (const s of Object.values(JointActivityStatus)) {
      const r = run(JointActivityEvent.FORCE_END, s);
      assert.equal(r.allowed, true, `${s} 应可被强停`);
      assert.equal(r.nextState, JointActivityStatus.FORCE_ENDED);
    }
  });

  it('终态冻结：ENDED/CANCELLED 下除 FORCE_END 外全部拒绝', () => {
    for (const terminal of [JointActivityStatus.ENDED, JointActivityStatus.CANCELLED]) {
      for (const ev of Object.values(JointActivityEvent)) {
        if (ev === JointActivityEvent.FORCE_END) continue;
        assert.equal(run(ev, terminal).allowed, false, `${terminal} 不应接受 ${ev}`);
      }
    }
  });

  it('错序拒绝抽查：各事件仅在声明源状态被接受', () => {
    assert.equal(run(JointActivityEvent.CONFIRM_ALL, JointActivityStatus.PUBLISHED).allowed, false);
    assert.equal(
      run(JointActivityEvent.PUBLISH, JointActivityStatus.DRAFT_CONFIRMING).allowed,
      false,
    );
    assert.equal(
      run(JointActivityEvent.SEND_FIRST_INVITATION, JointActivityStatus.ESTABLISHED).allowed,
      false,
    );
    assert.equal(
      run(JointActivityEvent.BEGIN_END_CONFIRM, JointActivityStatus.PUBLISHED).allowed,
      false,
    );
    assert.equal(run(JointActivityEvent.END, JointActivityStatus.INVITING).allowed, false);
  });
});
