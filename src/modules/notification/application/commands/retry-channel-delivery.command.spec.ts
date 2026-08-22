/**
 * 渠道投递重试命令测试（评审 #3：按 attemptId 直接定位，不依赖队首；
 * 评审 #1：24 小时窗口从首次失败时刻起算；评审 #2：重发复用内容快照）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type { EmailSendInput, EmailSendResult } from '../../infrastructure';
import {
  InMemoryChannelDeliveryAttemptRepository,
  InMemoryEmailAdapter,
  InMemoryNotificationRepository,
  InMemoryInboxAdapter,
  InMemoryPrivilegedAuditWriter,
} from '../../infrastructure';
import { RetryChannelDeliveryCommand } from './retry-channel-delivery.command';
import { MarkPermanentFailureCommand } from './mark-permanent-failure.command';
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

/** 构建独立的 MarkPermanentFailureCommand（承担 NTF-007 提示义务） */
function buildMarkPermanent(
  attemptRepo: InMemoryChannelDeliveryAttemptRepository,
): MarkPermanentFailureCommand {
  return new MarkPermanentFailureCommand(
    attemptRepo,
    new InMemoryNotificationRepository(),
    new InMemoryInboxAdapter(),
    new InMemoryPrivilegedAuditWriter(),
  );
}

describe('RetryChannelDeliveryCommand（评审 #3/#1/#2）', () => {
  let attempts: InMemoryChannelDeliveryAttemptRepository;
  let email: RecordingEmailAdapter;
  let command: RetryChannelDeliveryCommand;

  beforeEach(() => {
    attempts = new InMemoryChannelDeliveryAttemptRepository();
    email = new RecordingEmailAdapter();
    command = new RetryChannelDeliveryCommand(attempts, email, buildMarkPermanent(attempts));
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

  it('重试返回明确退信 BOUNCE → 立即进入永久失败，不再重试（NTF-007）', async () => {
    // 自定义适配器：重试发送返回 BOUNCE
    const bounceEmail = new (class extends InMemoryEmailAdapter {
      async send(_input: EmailSendInput): Promise<EmailSendResult> {
        return {
          status: 'BOUNCE',
          channelMessageId: null,
          sanitizedError: '550 5.1.1 mailbox does not exist',
        };
      }
    })();
    const cmd = new RetryChannelDeliveryCommand(
      attempts,
      bounceEmail,
      buildMarkPermanent(attempts),
    );
    await attempts.saveAttempt(makeAttempt('attempt-bounce', 'FAILED_RETRY'));

    await cmd.execute('attempt-bounce');
    const updated = await attempts.findAttemptById('attempt-bounce');
    assert.equal(updated?.status, 'PERMANENT_FAILURE');
    assert.equal(updated?.responseCategory, 'BOUNCE');
    assert.ok(updated?.completedAt, '永久失败应记录完成时间');
  });

  it('重试返回临时失败 → 继续进入失败重试并递增尝试序号/记录退避', async () => {
    const tempEmail = new (class extends InMemoryEmailAdapter {
      async send(_input: EmailSendInput): Promise<EmailSendResult> {
        return { status: 'TEMPORARY_FAILURE', channelMessageId: null, sanitizedError: 'timeout' };
      }
    })();
    const cmd = new RetryChannelDeliveryCommand(attempts, tempEmail, buildMarkPermanent(attempts));
    await attempts.saveAttempt(makeAttempt('attempt-temp', 'FAILED_RETRY'));

    await cmd.execute('attempt-temp');
    const updated = await attempts.findAttemptById('attempt-temp');
    assert.equal(updated?.status, 'FAILED_RETRY');
    assert.equal(updated?.attemptNumber, 2);
    assert.equal(updated?.responseCategory, 'TEMPORARY_FAILURE');
    assert.ok(updated?.nextRetryAt, '应记录下次重试时间');
  });
});
