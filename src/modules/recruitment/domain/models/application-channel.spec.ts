/**
 * 报名通道领域测试（REC-002）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ApplicationChannel } from './application-channel';
import { DefaultApplicationChannelStateMachine } from '../state-machines/application-channel.state-machine';

const NOW = new Date('2026-08-21T10:00:00.000Z');
const MACHINE = new DefaultApplicationChannelStateMachine();

function closed() {
  return ApplicationChannel.createClosed({ id: 'ch1', activityId: 'a1', clubId: 'c1', now: NOW });
}

describe('ApplicationChannel (REC-002)', () => {
  it('CLOSED → OPEN → PAUSED → OPEN → CLOSED', () => {
    const channel = closed();
    assert.equal(channel.open(MACHINE, NOW), true);
    assert.equal(channel.status, 'OPEN');
    assert.equal(channel.isAccepting(), true);
    channel.pause(NOW);
    assert.equal(channel.status, 'PAUSED');
    assert.equal(channel.isAccepting(), false);
    channel.resume(NOW);
    assert.equal(channel.status, 'OPEN');
    assert.equal(channel.close(MACHINE, NOW), true);
    assert.equal(channel.status, 'CLOSED');
    assert.equal(channel.closeAt !== null, true);
  });

  it('OPEN 才能暂停', () => {
    const channel = closed();
    assert.throws(() => channel.pause(NOW));
  });

  it('关闭后可重开新窗口（CLOSED → OPEN）', () => {
    const channel = closed();
    channel.open(MACHINE, NOW);
    channel.close(MACHINE, NOW);
    assert.equal(channel.open(MACHINE, NOW), true);
    assert.equal(channel.status, 'OPEN');
  });

  it('非 OPEN/PAUSED 不可关闭', () => {
    const channel = closed();
    assert.equal(channel.close(MACHINE, NOW), false);
  });
});
