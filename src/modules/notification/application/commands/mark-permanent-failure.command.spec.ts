/**
 * 永久失败标记命令测试（NTF-007）。
 * 覆盖：退信/24h 窗口进入永久失败；站内信提示用户；特权审计通知管理员；
 * 幂等（重复标记不产生重复提示）；站内信渠道不触发邮件提示。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryChannelDeliveryAttemptRepository,
  InMemoryNotificationRepository,
  InMemoryInboxAdapter,
} from '../../infrastructure';
import type { PrivilegedAuditEntry, PrivilegedAuditWriter } from '../../infrastructure';
import type { ChannelDeliveryAttemptModel } from '../../domain';
import { MarkPermanentFailureCommand } from './mark-permanent-failure.command';

class RecordingAudit implements PrivilegedAuditWriter {
  public entries: PrivilegedAuditEntry[] = [];
  async write(entry: PrivilegedAuditEntry): Promise<string> {
    this.entries.push(entry);
    return 'audit-' + this.entries.length;
  }
}

describe('MarkPermanentFailureCommand（NTF-007 停止重试与提示义务）', () => {
  let attempts: InMemoryChannelDeliveryAttemptRepository;
  let repo: InMemoryNotificationRepository;
  let inbox: InMemoryInboxAdapter;
  let audit: RecordingAudit;
  let command: MarkPermanentFailureCommand;

  beforeEach(() => {
    attempts = new InMemoryChannelDeliveryAttemptRepository();
    repo = new InMemoryNotificationRepository();
    inbox = new InMemoryInboxAdapter();
    audit = new RecordingAudit();
    command = new MarkPermanentFailureCommand(attempts, repo, inbox, audit);
  });

  async function seedEmailAttempt(): Promise<ChannelDeliveryAttemptModel> {
    const { fact, snapshots } = await repo.saveFactWithSnapshots(
      {
        logicalEventId: 'evt-1',
        sourceObjectId: 'app-1',
        sourceObjectVersion: 1,
        sourceCommandId: 'cmd-1',
        eventType: 'conclusion',
        eventTime: new Date().toISOString(),
        summary: '招新结论：通过',
        targetObjectRef: '/recruitment/apply/1',
        deadlineAt: null,
        scope: { type: 'CLUB', clubId: 'club-1' },
      },
      [
        {
          snapshotId: '',
          factId: '',
          recipientId: 'student-1',
          reason: '本人',
          dedupKey: 'evt-1\u0000student-1',
          scope: { type: 'CLUB', clubId: 'club-1' },
          createdAt: new Date().toISOString(),
        },
      ],
    );
    return attempts.saveAttempt({
      attemptId: 'att-1',
      factId: fact.factId,
      snapshotId: snapshots[0].snapshotId,
      recipientId: 'student-1',
      channel: 'EMAIL',
      channelMessageId: null,
      attemptNumber: 3,
      status: 'FAILED_RETRY',
      targetAddress: 'student@student.edu',
      templateVersionId: null,
      senderIdentity: '动漫社 <club@x.edu>',
      emailSubject: '结果通知',
      emailBody: '<p>通过</p>',
      firstFailedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
      responseCategory: 'TEMPORARY_FAILURE',
      sanitizedError: null,
      nextRetryAt: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      version: 1,
    });
  }

  it('失败重试中的邮件尝试 → 永久失败＋站内信提示用户＋审计通知管理员', async () => {
    const attempt = await seedEmailAttempt();
    await command.execute(attempt.attemptId);

    const stored = await attempts.findAttemptById(attempt.attemptId);
    assert.equal(stored?.status, 'PERMANENT_FAILURE');

    // 站内信提示：为收件人创建了 system 类型呈现
    const list = await inbox.listForUser('student-1', { includeHidden: true }, null, 10);
    const notice = list.find((p) => p.eventType === 'system');
    assert.ok(notice, '必须创建站内信提示');
    assert.ok(notice.body.includes('未能送达'), '提示内容最少化');

    // 管理员通知：特权审计
    const adminNotice = audit.entries.find(
      (e) => e.action === 'notification.email.permanent_failure',
    );
    assert.ok(adminNotice, '必须写管理员可见审计');
    assert.equal(adminNotice.targetId, attempt.attemptId);
  });

  it('仅通知本次邮件投递失败的收件人，不误告同一事实的其他收件人（NTF-007）', async () => {
    const { fact, snapshots } = await repo.saveFactWithSnapshots(
      {
        logicalEventId: 'evt-multi',
        sourceObjectId: 'app-multi',
        sourceObjectVersion: 1,
        sourceCommandId: 'cmd-multi',
        eventType: 'conclusion',
        eventTime: new Date().toISOString(),
        summary: '招新结论：通过',
        targetObjectRef: null,
        deadlineAt: null,
        scope: { type: 'CLUB', clubId: 'club-1' },
      },
      [
        {
          snapshotId: '',
          factId: '',
          recipientId: 'student-a',
          reason: '本人',
          dedupKey: 'evt-multi\u0000student-a',
          scope: { type: 'CLUB', clubId: 'club-1' },
          createdAt: new Date().toISOString(),
        },
        {
          snapshotId: '',
          factId: '',
          recipientId: 'student-b',
          reason: '本人',
          dedupKey: 'evt-multi\u0000student-b',
          scope: { type: 'CLUB', clubId: 'club-1' },
          createdAt: new Date().toISOString(),
        },
      ],
    );
    const multi = await attempts.saveAttempt({
      attemptId: 'att-multi',
      factId: fact.factId,
      snapshotId: snapshots[0].snapshotId,
      recipientId: 'student-a',
      channel: 'EMAIL',
      channelMessageId: null,
      attemptNumber: 3,
      status: 'FAILED_RETRY',
      targetAddress: 'student-a@student.edu',
      templateVersionId: null,
      senderIdentity: '动漫社 <club@x.edu>',
      emailSubject: '结果通知',
      emailBody: '<p>通过</p>',
      firstFailedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
      responseCategory: 'TEMPORARY_FAILURE',
      sanitizedError: null,
      nextRetryAt: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      version: 1,
    });
    await command.execute(multi.attemptId);

    // 只有 student-a（邮件投递失败的收件人）收到提示，student-b 不受影响
    const noticeA = await inbox.listForUser('student-a', { includeHidden: true }, null, 10);
    assert.ok(
      noticeA.some((p) => p.eventType === 'system'),
      '受影响收件人必须收到站内信提示',
    );
    const noticeB = await inbox.listForUser('student-b', { includeHidden: true }, null, 10);
    assert.ok(!noticeB.some((p) => p.eventType === 'system'), '未受影响收件人不得收到提示');
  });

  it('重复执行幂等：不产生重复站内信提示', async () => {
    const attempt = await seedEmailAttempt();
    await command.execute(attempt.attemptId);
    // 第二次：状态已是 PERMANENT_FAILURE，状态机拒绝，不再提示
    await command.execute(attempt.attemptId);
    const list = await inbox.listForUser('student-1', { includeHidden: true }, null, 10);
    const notices = list.filter((p) => p.eventType === 'system');
    assert.equal(notices.length, 1);
  });

  it('站内信渠道尝试进入永久失败不触发邮件提示链路', async () => {
    const { fact, snapshots } = await repo.saveFactWithSnapshots(
      {
        logicalEventId: 'evt-2',
        sourceObjectId: 'app-2',
        sourceObjectVersion: 1,
        sourceCommandId: 'cmd-2',
        eventType: 'invitation',
        eventTime: new Date().toISOString(),
        summary: '邀请',
        targetObjectRef: null,
        deadlineAt: null,
        scope: { type: 'PLATFORM', clubId: null },
      },
      [
        {
          snapshotId: '',
          factId: '',
          recipientId: 'student-2',
          reason: '本人',
          dedupKey: 'evt-2\u0000student-2',
          scope: { type: 'PLATFORM', clubId: null },
          createdAt: new Date().toISOString(),
        },
      ],
    );
    const attempt = await attempts.saveAttempt({
      attemptId: 'att-inbox',
      factId: fact.factId,
      snapshotId: snapshots[0].snapshotId,
      recipientId: 'student-2',
      channel: 'INBOX',
      channelMessageId: null,
      attemptNumber: 1,
      status: 'FAILED_RETRY',
      targetAddress: null,
      templateVersionId: null,
      senderIdentity: null,
      emailSubject: null,
      emailBody: null,
      firstFailedAt: new Date().toISOString(),
      responseCategory: 'TEMPORARY_FAILURE',
      sanitizedError: null,
      nextRetryAt: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      version: 1,
    });
    await command.execute(attempt.attemptId);
    const stored = await attempts.findAttemptById('att-inbox');
    assert.equal(stored?.status, 'PERMANENT_FAILURE');
    assert.equal(audit.entries.length, 0, '站内信渠道无邮件提示义务');
  });
});
