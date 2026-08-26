/**
 * JointChannel 领域模型逐方法测试（JNT-006；覆盖率提升）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JointChannel } from './joint-channel';
import {
  JointChannelStateMachine,
  JointChannelStatus,
} from '../state-machines/joint-channel.state-machine';

const machine = new JointChannelStateMachine();
const NOW = new Date('2026-08-01T00:00:00Z');
const DEADLINE = new Date('2026-09-01T00:00:00Z');

function makeClosed() {
  return JointChannel.createClosed({ jointActivityId: 'act-001', now: NOW });
}

describe('JointChannel（领域模型）', () => {
  it('channelId：派生自 activityId', () => {
    assert.equal(JointChannel.channelId('act-001'), 'channel:act-001');
  });

  it('createClosed：初始 NOT_OPEN + 无窗口', () => {
    const c = makeClosed();
    assert.equal(c.status, JointChannelStatus.NOT_OPEN);
    assert.equal(c.currentWindow, null);
    assert.equal(c.isOpen(NOW), false);
  });

  it('fromSnapshot → toSnapshot：快照往返一致', () => {
    const original = makeClosed().toSnapshot();
    const restored = JointChannel.fromSnapshot(original);
    assert.deepEqual(restored.toSnapshot(), original);
  });

  it('open：NOT_OPEN → OPEN + 创建截止窗口', () => {
    const c = makeClosed();
    c.open(machine, { windowId: 'w1', deadline: DEADLINE, now: NOW });
    assert.equal(c.status, JointChannelStatus.OPEN);
    assert.ok(c.currentWindow);
    assert.equal(c.isOpen(new Date(NOW.getTime() + 1000)), true);
  });

  it('suspend/resume：OPEN → SUSPENDED → OPEN（新窗口）', () => {
    const c = makeClosed();
    c.open(machine, { windowId: 'w1', deadline: DEADLINE, now: NOW });
    c.suspend(machine, NOW);
    assert.equal(c.status, JointChannelStatus.SUSPENDED);
    c.resume(machine, { windowId: 'w2', deadline: DEADLINE, now: NOW });
    assert.equal(c.status, JointChannelStatus.OPEN);
  });

  it('close：OPEN/SUSPENDED → CLOSED_FINAL；reopen → OPEN', () => {
    const c = makeClosed();
    c.open(machine, { windowId: 'w1', deadline: DEADLINE, now: NOW });
    c.close(machine, NOW);
    assert.equal(c.status, JointChannelStatus.CLOSED_FINAL);
    c.reopen(machine, { windowId: 'w2', deadline: DEADLINE, now: NOW });
    assert.equal(c.status, JointChannelStatus.OPEN);
  });

  it('extend：OPEN 状态下延长截止时间（自环）', () => {
    const c = makeClosed();
    c.open(machine, { windowId: 'w1', deadline: DEADLINE, now: NOW });
    const beforeDeadline = c.toSnapshot().currentWindow?.deadline;
    c.extend(machine, { deadline: new Date('2026-10-15'), now: NOW });
    assert.equal(c.status, JointChannelStatus.OPEN);
    const afterDeadline = c.toSnapshot().currentWindow?.deadline;
    assert.ok(
      afterDeadline && beforeDeadline && afterDeadline.getTime() >= beforeDeadline.getTime(),
    );
  });
});
