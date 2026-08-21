/**
 * 渠道投递重试命令测试（评审 #3：按 attemptId 直接定位，不依赖队首；
 * 评审 #1：24 小时窗口从首次失败时刻起算；评审 #2：重发复用内容快照）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type { EmailSendInput } from '../../infrastructure';
import {
  InMemoryChannelDeliveryAttemptRepository,
  InMemoryEmailAdapter,
} from '../../infrastructure';
import { RetryChannelDeliveryCommand } from './retry-channel-delivery.command';
import type { ChannelDeliveryAttemptModel } from '../../domain';

function makeAttempt(
  attemptId: string,
  status: ChannelDeliveryAttemptModel['status'],
  overrides: Partial<ChannelDeliveryAttemptModel> = {},
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
    emailSubject: '面试时间确认',
    emailBody: '你的面试已安排',
    firstFailedAt: null,
    responseCategory: 'TEMPORARY_FAILURE',
    sanitizedError: 'smtp timeout',
    nextRetryAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    completedAt: null,
    version: 1,
    ...overrides,
  };
}

/** 记录发送输入的邮件适配器 */
class RecordingEmailAdapter extends InMemoryEmailAdapter {
  readonly sent: EmailSendInput[] = [];
  async send(input: EmailSendInput) {
    this.sent.push(input);
    return super.send(input);
  }
}

describe('RetryChannelDeliveryCommand（评审 #3/#1/#2）', () => {
  let attempts: InMemoryChannelDeliveryAttemptRepository;
  let email: RecordingEmailAdapter;
  let command: RetryChannelDeliveryCommand;

  beforeEach(() => {
    attempts = new InMemoryChannelDeliveryAttemptRepository();
    email = new RecordingEmailAdapter();
    command = new RetryChannelDeliveryCommand(attempts, email);
  });

  it('指定非队首 attemptId 也能被定位并重试成功（评审 #3）', async () => {
    await attempts.saveAttempt(makeAttempt('attempt-1', 'FAILED_RETRY'));
    await attempts.saveAttempt(makeAttempt('attempt-2', 'FAILED_RETRY'));
    await attempts.saveAttempt(makeAttempt('attempt-3', 'FAILED_RETRY'));

    // 重试队尾的 attempt-3（旧实现 findRetryableAttempts(1).find 永远匹配不到）
    await command.execute('attempt-3');

    const updated = await attempts.findAttemptById('attempt-3');
    assert.equal(updated?.status, 'DELIVERED');
    assert.ok(updated?.channelMessageId);
  });

  it('重发复用创建时冻结的内容快照，不产生空邮件（评审 #2）', async () => {
    await attempts.saveAttempt(
      makeAttempt('attempt-content', 'FAILED_RETRY', {
        emailSubject: '录取邀请',
        emailBody: '请于 9 月 20 日前确认',
      }),
    );
    await command.execute('attempt-content');
    assert.equal(email.sent.length, 1);
    assert.equal(email.sent[0].subject, '录取邀请');
    assert.equal(email.sent[0].body, '请于 9 月 20 日前确认');
    assert.equal(email.sent[0].senderIdentity, 'club-1');
  });

  it('24 小时窗口从首次失败时刻起算：firstFailedAt 距今超过 24h → 永久失败（评审 #1）', async () => {
    const now = new Date();
    const firstFailedAt = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const createdAt = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString();
    await attempts.saveAttempt(
      makeAttempt('attempt-expired', 'FAILED_RETRY', { firstFailedAt, createdAt }),
    );
    await command.execute('attempt-expired');
    const updated = await attempts.findAttemptById('attempt-expired');
    assert.equal(updated?.status, 'PERMANENT_FAILURE');
    assert.equal(email.sent.length, 0, '超过窗口不应再发送');
  });

  it('firstFailedAt 距今不足 24h（即使 createdAt 更早）→ 继续重试（评审 #1）', async () => {
    const now = new Date();
    const firstFailedAt = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString();
    // createdAt 在 48 小时前（旧实现会误判为超时）
    const createdAt = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
    await attempts.saveAttempt(
      makeAttempt('attempt-active', 'FAILED_RETRY', { firstFailedAt, createdAt }),
    );
    await command.execute('attempt-active');
    const updated = await attempts.findAttemptById('attempt-active');
    assert.equal(updated?.status, 'DELIVERED');
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
