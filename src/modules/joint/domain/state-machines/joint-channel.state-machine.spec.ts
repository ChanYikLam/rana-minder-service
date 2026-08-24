/**
 * 联合报名通道状态机逐转换测试（JNT-006；SRS-SM-JNT-006；P3 补测）。
 *
 * 独立四态通道：未开放/开放/暂停/已关闭；暂停废止旧截止窗口，
 * 关闭为终态但可 REOPEN 重开新窗口（非终态重开）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  JointChannelEvent,
  JointChannelStateMachine,
  JointChannelStatus,
} from './joint-channel.state-machine';

const machine = new JointChannelStateMachine();

function run(event: JointChannelEvent, state: JointChannelStatus) {
  return machine.transition({ event, currentState: state });
}

describe('JointChannelStateMachine（JNT-006）', () => {
  it('主链：NOT_OPEN→OPEN→SUSPENDED→OPEN(恢复)，各步允许且次态正确', () => {
    assert.deepEqual(run(JointChannelEvent.OPEN, JointChannelStatus.NOT_OPEN), {
      allowed: true,
      nextState: JointChannelStatus.OPEN,
    });
    assert.deepEqual(run(JointChannelEvent.SUSPEND, JointChannelStatus.OPEN), {
      allowed: true,
      nextState: JointChannelStatus.SUSPENDED,
    });
    assert.deepEqual(run(JointChannelEvent.RESUME, JointChannelStatus.SUSPENDED), {
      allowed: true,
      nextState: JointChannelStatus.OPEN,
    });
  });

  it('EXTEND：仅 OPEN 允许且自环（新截止窗口）', () => {
    const r = run(JointChannelEvent.EXTEND, JointChannelStatus.OPEN);
    assert.equal(r.allowed, true);
    assert.equal(r.nextState, JointChannelStatus.OPEN);
    assert.equal(run(JointChannelEvent.EXTEND, JointChannelStatus.SUSPENDED).allowed, false);
  });

  it('CLOSE：OPEN/SUSPENDED → CLOSED_FINAL（截止任务自动关闭）', () => {
    for (const s of [JointChannelStatus.OPEN, JointChannelStatus.SUSPENDED]) {
      const r = run(JointChannelEvent.CLOSE, s);
      assert.equal(r.allowed, true, `${s} 应可关闭`);
      assert.equal(r.nextState, JointChannelStatus.CLOSED_FINAL);
    }
    assert.equal(run(JointChannelEvent.CLOSE, JointChannelStatus.NOT_OPEN).allowed, false);
  });

  it('REOPEN：仅 CLOSED_FINAL → OPEN（非终态重开新窗口）', () => {
    assert.deepEqual(run(JointChannelEvent.REOPEN, JointChannelStatus.CLOSED_FINAL), {
      allowed: true,
      nextState: JointChannelStatus.OPEN,
    });
    assert.equal(run(JointChannelEvent.REOPEN, JointChannelStatus.OPEN).allowed, false);
  });

  it('错序拒绝抽查', () => {
    assert.equal(run(JointChannelEvent.OPEN, JointChannelStatus.OPEN).allowed, false);
    assert.equal(run(JointChannelEvent.SUSPEND, JointChannelStatus.NOT_OPEN).allowed, false);
    assert.equal(run(JointChannelEvent.RESUME, JointChannelStatus.OPEN).allowed, false);
  });
});
