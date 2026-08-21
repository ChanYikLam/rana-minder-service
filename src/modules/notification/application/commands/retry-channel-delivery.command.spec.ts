/**
 * 渠道投递重试命令测试（评审 #3：按 attemptId 直接定位，
 * 不依赖 findRetryableAttempts 队首顺序）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryChannelDeliveryAttemptRepository,
  InMemoryEmailAdapter,
} from '../../infrastructure';
import { RetryChannelDeliveryCommand } from './retry-channel-delivery.command';
import type { ChannelDeliveryAttemptModel } from '../../domain';

function makeAttempt(
  attemptId: string,
  status: ChannelDeliveryAttemptModel['status'],
): ChannelDeliveryAttemptModel {
  return {
    attemptId,
    factId: `fact-${attemptId}`,
    snapshotId: `snap-${attemptId}`,
    channel: 'EMAIL',
    channelMessageId: null,
    attemptNumber: 1,
    status,
    targetAddress: 'stu@example.com',
    templateVersionId: null,
    senderIdentity: 'club-1',
    responseCategory: 'TEMPORARY_FAILURE',
    sanitizedError: 'smtp timeout',
    nextRetryAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    completedAt: null,
    version: 1,
  };
}

describe('RetryChannelDeliveryCommand（评审 #3：非队首尝试也可重试）', () => {
  let attempts: InMemoryChannelDeliveryAttemptRepository;
  let command: RetryChannelDeliveryCommand;

  beforeEach(() => {
    attempts = new InMemoryChannelDeliveryAttemptRepository();
    command = new RetryChannelDeliveryCommand(attempts, new InMemoryEmailAdapter());
  });

  it('指定非队首 attemptId 也能被定位并重试成功', async () => {
    await attempts.saveAttempt(makeAttempt('attempt-1', 'FAILED_RETRY'));
    await attempts.saveAttempt(makeAttempt('attempt-2', 'FAILED_RETRY'));
    await attempts.saveAttempt(makeAttempt('attempt-3', 'FAILED_RETRY'));

    // 重试队尾的 attempt-3（旧实现 findRetryableAttempts(1).find 永远匹配不到）
    await command.execute('attempt-3');

    const updated = await attempts.findAttemptById('attempt-3');
    assert.equal(updated?.status, 'DELIVERED');
    assert.ok(updated?.channelMessageId);
  });

  it('不存在的尝试 → 忽略不抛错', async () => {
    await command.execute('no-such-attempt');
  });

  it('非失败重试状态的尝试 → 忽略', async () => {
    await attempts.saveAttempt(makeAttempt('attempt-delivered', 'DELIVERED'));
    await command.execute('attempt-delivered');
    const updated = await attempts.findAttemptById('attempt-delivered');
    assert.equal(updated?.status, 'DELIVERED');
  });
});
