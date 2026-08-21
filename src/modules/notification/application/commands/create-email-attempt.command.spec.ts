/**
 * 创建邮件投递尝试测试（评审 #3：投递尝试可回溯收件人快照；
 * 评审 #2：保存内容快照供重试复用；评审 #1：首次失败时间记录）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryChannelDeliveryAttemptRepository,
  InMemoryEmailAdapter,
  InMemoryNotificationRepository,
  InMemoryTemplateSnapshotService,
} from '../../infrastructure';
import { CreateEmailAttemptCommand } from './create-email-attempt.command';
import type { CreateNotificationFactInput, RecipientSnapshot } from '../../domain';

describe('CreateEmailAttemptCommand（评审 #3/#1/#2）', () => {
  let repo: InMemoryNotificationRepository;
  let attempts: InMemoryChannelDeliveryAttemptRepository;
  let command: CreateEmailAttemptCommand;
  let seq = 0;

  beforeEach(() => {
    seq += 1;
    repo = new InMemoryNotificationRepository();
    attempts = new InMemoryChannelDeliveryAttemptRepository();
    command = new CreateEmailAttemptCommand(
      repo,
      attempts,
      new InMemoryEmailAdapter(),
      new InMemoryTemplateSnapshotService(),
    );
  });

  async function createFactWithSnapshot(recipientId: string): Promise<string> {
    const input: CreateNotificationFactInput = {
      logicalEventId: `logical-email-${seq}-${recipientId}`,
      sourceObjectId: `src-${seq}`,
      sourceObjectVersion: 1,
      sourceCommandId: `cmd-${seq}`,
      eventType: 'invitation',
      eventTime: '2026-09-08T00:00:00.000Z',
      summary: '录取邀请：请于 9 月 20 日前确认',
      targetObjectRef: '/me/invitations/1',
      scope: { type: 'CLUB', clubId: 'club-1' },
    };
    const snapshot: RecipientSnapshot = {
      snapshotId: '',
      factId: '',
      recipientId,
      reason: '本人',
      scope: { type: 'CLUB', clubId: 'club-1' },
      dedupKey: input.logicalEventId,
      createdAt: '',
    };
    const saved = await repo.saveFactWithSnapshots(input, [snapshot]);
    return saved.fact.factId;
  }

  it('投递尝试保存收件人快照引用（snapshotId 非空，可回溯）', async () => {
    const factId = await createFactWithSnapshot('stu-1');
    const attempt = await command.execute({
      factId,
      recipientId: 'stu-1',
      recipientEmail: 'stu@example.com',
      eventAllowsEmail: true,
      configClosedEmail: false,
      userUnsubscribed: false,
      emailVerified: true,
      senderAccountValid: true,
      eventType: 'invitation',
    });

    assert.ok(attempt, '应创建尝试');
    assert.ok(attempt.snapshotId, 'snapshotId 必须关联收件人快照');
    const snapshots = await repo.findSnapshotsByFactId(factId);
    assert.equal(attempt.snapshotId, snapshots[0].snapshotId);
  });

  it('投递尝试保存邮件标题/正文快照与发件身份（重试不产生空邮件）', async () => {
    const factId = await createFactWithSnapshot('stu-1');
    const attempt = await command.execute({
      factId,
      recipientId: 'stu-1',
      recipientEmail: 'stu@example.com',
      eventAllowsEmail: true,
      configClosedEmail: false,
      userUnsubscribed: false,
      emailVerified: true,
      senderAccountValid: true,
      eventType: 'invitation',
    });

    assert.equal(attempt?.emailSubject, '录取邀请：请于 9 月 20 日前确认');
    assert.equal(attempt?.emailBody, '录取邀请：请于 9 月 20 日前确认');
    assert.equal(attempt?.senderIdentity, 'club-1');
  });

  it('发送临时失败 → 记录首次失败时间并进入失败重试', async () => {
    const factId = await createFactWithSnapshot('stu-1');
    // 用固定失败的邮件适配器
    const failingAdapter = {
      async send() {
        return {
          status: 'TEMPORARY_FAILURE' as const,
          channelMessageId: null,
          sanitizedError: 'smtp timeout',
        };
      },
    };
    const failingCommand = new CreateEmailAttemptCommand(
      repo,
      attempts,
      failingAdapter,
      new InMemoryTemplateSnapshotService(),
    );
    const attempt = await failingCommand.execute({
      factId,
      recipientId: 'stu-1',
      recipientEmail: 'stu@example.com',
      eventAllowsEmail: true,
      configClosedEmail: false,
      userUnsubscribed: false,
      emailVerified: true,
      senderAccountValid: true,
      eventType: 'invitation',
    });

    const stored = await attempts.findAttemptById(attempt!.attemptId);
    assert.equal(stored?.status, 'FAILED_RETRY');
    assert.ok(stored?.firstFailedAt, '首次失败时间必须记录');
    assert.ok(stored?.nextRetryAt, '退避时间必须计算');
  });

  it('收件人快照缺失 → 不创建投递尝试', async () => {
    const factId = await createFactWithSnapshot('stu-1');
    const attempt = await command.execute({
      factId,
      recipientId: 'other-user',
      recipientEmail: 'other@example.com',
      eventAllowsEmail: true,
      configClosedEmail: false,
      userUnsubscribed: false,
      emailVerified: true,
      senderAccountValid: true,
      eventType: 'invitation',
    });
    assert.equal(attempt, null);
  });
});
