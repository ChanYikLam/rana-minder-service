/**
 * 通知投递后台任务处理器功能测试（评审 #1：按任务 payload 实际调用
 * 投递/重试命令，factId/attemptId 从 payload 解析）。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { TaskType } from '../../contracts';
import type { TaskRecord } from '../../contracts';
import {
  InMemoryChannelDeliveryAttemptRepository,
  InMemoryEmailAdapter,
  InMemoryInboxAdapter,
  InMemoryNotificationRepository,
} from '../../../../modules/notification/infrastructure';
import { DeliverInboxCommand } from '../../../../modules/notification/application/commands/deliver-inbox.command';
import { RetryChannelDeliveryCommand } from '../../../../modules/notification/application/commands/retry-channel-delivery.command';
import { MarkPermanentFailureCommand } from '../../../../modules/notification/application/commands/mark-permanent-failure.command';
import { InMemoryPrivilegedAuditWriter } from '../../../../modules/notification/infrastructure';
import { NotificationDeliveryHandler } from './notification-delivery.handler';
import type {
  CreateNotificationFactInput,
  RecipientSnapshot,
} from '../../../../modules/notification/domain';

describe('NotificationDeliveryHandler（评审 #1：后台投递链路生效）', () => {
  let repo: InMemoryNotificationRepository;
  let inbox: InMemoryInboxAdapter;
  let attempts: InMemoryChannelDeliveryAttemptRepository;
  let handler: NotificationDeliveryHandler;
  let seq = 0;

  beforeEach(() => {
    seq += 1;
    repo = new InMemoryNotificationRepository();
    inbox = new InMemoryInboxAdapter();
    attempts = new InMemoryChannelDeliveryAttemptRepository();
    handler = new NotificationDeliveryHandler(
      new DeliverInboxCommand(repo, inbox),
      new RetryChannelDeliveryCommand(
        attempts,
        new InMemoryEmailAdapter(),
        new MarkPermanentFailureCommand(attempts, repo, inbox, new InMemoryPrivilegedAuditWriter()),
      ),
    );
  });

  function makeTask(intent: string, payload: Record<string, unknown>): TaskRecord {
    return {
      taskId: `task-${seq}-${intent}`,
      intentId: `intent-${seq}-${intent}`,
      taskType: TaskType.NOTIFICATION_DELIVERY,
      status: 'PENDING',
      payload: { intent, ...payload },
      attempts: 0,
      idempotencyKey: `idem-${seq}-${intent}`,
      scope: { type: 'PLATFORM' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    } as unknown as TaskRecord;
  }

  async function createFact(): Promise<{ factId: string; version: number }> {
    const input: CreateNotificationFactInput = {
      logicalEventId: `logical-h-${seq}`,
      sourceObjectId: `src-${seq}`,
      sourceObjectVersion: 1,
      sourceCommandId: `cmd-${seq}`,
      eventType: 'invitation',
      eventTime: '2026-09-08T00:00:00.000Z',
      summary: `邀请通知 ${seq}`,
      targetObjectRef: '/me/invitations/1',
      scope: { type: 'CLUB', clubId: 'club-1' },
    };
    const snapshot: RecipientSnapshot = {
      snapshotId: '',
      factId: '',
      recipientId: 'stu-1',
      reason: '本人',
      scope: { type: 'CLUB', clubId: 'club-1' },
      dedupKey: input.logicalEventId,
      createdAt: '',
    };
    const saved = await repo.saveFactWithSnapshots(input, [snapshot]);
    return { factId: saved.fact.factId, version: saved.fact.version };
  }

  it('deliver_inbox 意图：解析 payload.factId 并真正投递，生成站内信呈现', async () => {
    const { factId, version } = await createFact();
    await handler.handle(makeTask('deliver_inbox', { factId, expectedVersion: version }));

    const fact = await repo.findFactById(factId);
    assert.equal(fact?.status, 'DELIVERED', '事实必须推进为已投递');
    const items = await inbox.listForUser('stu-1', {}, null, 100);
    assert.equal(items.length, 1, '必须创建站内信呈现');
  });

  it('retry_channel 意图：解析 payload.attemptId 并调用重试命令', async () => {
    const { factId } = await createFact();
    await attempts.saveAttempt({
      attemptId: `attempt-h-${seq}`,
      factId,
      snapshotId: `snap-h-${seq}`,
      channel: 'EMAIL',
      channelMessageId: null,
      attemptNumber: 1,
      status: 'FAILED_RETRY',
      targetAddress: 'stu@example.com',
      templateVersionId: null,
      senderIdentity: 'club-1',
      emailSubject: '面试时间确认',
      emailBody: '你的面试已安排',
      firstFailedAt: null,
      responseCategory: 'TEMPORARY_FAILURE',
      sanitizedError: 'timeout',
      nextRetryAt: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      completedAt: null,
      version: 1,
    });

    await handler.handle(makeTask('retry_channel', { attemptId: `attempt-h-${seq}` }));
    const updated = await attempts.findAttemptById(`attempt-h-${seq}`);
    assert.equal(updated?.status, 'DELIVERED', '重试命令必须真正执行');
  });

  it('未知意图 → 抛不可重试错误，进入 MANUAL_INTERVENTION（BUG-010）', async () => {
    await assert.rejects(
      () => handler.handle(makeTask('unknown', {})),
      /未知任务意图/,
    );
  });
});
