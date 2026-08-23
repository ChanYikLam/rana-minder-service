/**
 * 报名通道领域测试（REC-002）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ApplicationChannel } from './application-channel';
import { DefaultApplicationChannelStateMachine } from '../state-machines/application-channel.state-machine';

const NOW = new Date('2026-08-21T10:00:00.000Z');
const MACHINE = new DefaultApplicationChannelStateMachine();

function notStarted() {
  return ApplicationChannel.createNotStarted({
    id: 'ch1',
    activityId: 'a1',
    clubId: 'c1',
    now: NOW,
  });
}

describe('ApplicationChannel (REC-002)', () => {
  it('未开放 → OPEN → PAUSED → OPEN → CLOSED（SRS-SM-REC-002 四态）', () => {
    const channel = notStarted();
    assert.equal(channel.status, 'NOT_STARTED');
    assert.equal(channel.open(MACHINE, NOW), true);
    assert.equal(channel.status, 'OPEN');
    assert.equal(channel.isAccepting(), true);
    channel.pause(NOW);
    assert.equal(channel.status, 'PAUSED');
    assert.equal(channel.isAccepting(), false);
    channel.resume(NOW);
    assert.equal(channel.status, 'OPEN');
    channel.close(MACHINE, NOW);
    assert.equal(channel.status, 'CLOSED');
    assert.equal(channel.closeAt !== null, true);
  });

  it('OPEN 才能暂停', () => {
    const channel = notStarted();
    channel.open(MACHINE, NOW);
    channel.pause(NOW);
    assert.throws(() => channel.pause(NOW));
  });

  it('关闭后重开须携严格晚于重开时刻的新截止（SRS-SM-REC-002 重开守卫）', () => {
    const channel = notStarted();
    channel.open(MACHINE, NOW);
    channel.close(MACHINE, NOW);
    // 无守卫参数 → 拒绝
    assert.equal(channel.open(MACHINE, NOW), false);
    assert.equal(channel.status, 'CLOSED');
    // 新截止不晚于重开时刻 → 拒绝
    assert.equal(
      channel.open(MACHINE, NOW, { newDeadlineStrictlyAfterNow: false }),
      false,
    );
    // 新截止合法 → 允许
    assert.equal(
      channel.open(MACHINE, NOW, { newDeadlineStrictlyAfterNow: true }),
      true,
    );
    assert.equal(channel.status, 'OPEN');
  });
});
