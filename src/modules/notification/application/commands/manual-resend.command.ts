/**
 * 人工补发命令（NTF-007、SRS-SM-NTF-001 转换 10）。
 *
 * 人工重发只重发通知，不重执行原业务。
 * 新建关联原通知事实的邮件尝试，旧投递记录保留；
 * 尝试保存收件人快照引用与内容快照，失败可重试且不产生空邮件。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  ChannelDeliveryAttemptRepository,
  EmailAdapter,
  NotificationRepository,
  TemplateSnapshotService,
} from '../../infrastructure';
import type { ChannelDeliveryAttemptModel } from '../../domain';
import { computeNextRetryAt, NotificationStateMachine } from '../../domain';
import {
  CHANNEL_DELIVERY_ATTEMPT_REPOSITORY,
  EMAIL_ADAPTER,
  NOTIFICATION_REPOSITORY,
  TEMPLATE_SNAPSHOT_SERVICE,
} from '../../tokens';

@Injectable()
export class ManualResendCommand {
  private readonly logger = new Logger(ManualResendCommand.name);
  private readonly stateMachine = new NotificationStateMachine();

  constructor(
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repository: NotificationRepository,
    @Inject(CHANNEL_DELIVERY_ATTEMPT_REPOSITORY)
    private readonly attemptRepository: ChannelDeliveryAttemptRepository,
    @Inject(EMAIL_ADAPTER)
    private readonly emailAdapter: EmailAdapter,
    @Inject(TEMPLATE_SNAPSHOT_SERVICE)
    private readonly templateService: TemplateSnapshotService,
  ) {}

  /**
   * 人工补发通知。
   * 只重发通知，不重执行原业务（NTF-007）。
   *
   * @param factId 原通知事实标识
   * @param targetEmail 当前已验证邮箱
   * @param eventType 原事件类型
   */
  async execute(
    factId: string,
    targetEmail: string,
    eventType: string,
  ): Promise<ChannelDeliveryAttemptModel | null> {
    const fact = await this.repository.findFactById(factId);
    if (!fact) {
      this.logger.warn(`通知事实不存在，无法人工补发: ${factId}`);
      return null;
    }

    const templateVersionId = await this.templateService.snapshotTemplate(eventType, 'EMAIL');

    // 回溯收件人快照，保证投递尝试与快照的关联完整性（DATA-NTF-001）。
    // 人工补发不传入收件人标识，取该事实的首条收件人快照作为关联引用；
    // 若确实需要精确定位收件人，应由调用方传入 recipientId 匹配。
    const snapshots = await this.repository.findSnapshotsByFactId(factId);
    const snapshot = snapshots[0] ?? null;

    const now = new Date().toISOString();
    const newAttempt: ChannelDeliveryAttemptModel = {
      attemptId: `manual-resend-${factId}-${Date.now()}`,
      factId,
      snapshotId: snapshot?.snapshotId ?? null,
      recipientId: snapshot?.recipientId ?? null,
      channel: 'EMAIL',
      channelMessageId: null,
      attemptNumber: 1,
      status: 'PENDING',
      targetAddress: targetEmail,
      templateVersionId,
      senderIdentity: fact.scope.type === 'CLUB' ? fact.scope.clubId : 'platform',
      // 内容快照（NTF-002 最少摘要）：重试时复用，避免空邮件
      emailSubject: fact.summary.slice(0, 100),
      emailBody: fact.summary,
      firstFailedAt: null,
      responseCategory: null,
      sanitizedError: null,
      nextRetryAt: null,
      createdAt: now,
      completedAt: null,
      version: 1,
    };

    await this.attemptRepository.saveAttempt(newAttempt);

    let latestAttempt: ChannelDeliveryAttemptModel = newAttempt;
    try {
      const result = await this.emailAdapter.send({
        to: targetEmail,
        subject: newAttempt.emailSubject ?? fact.summary.slice(0, 100),
        body: newAttempt.emailBody ?? fact.summary,
        senderIdentity: newAttempt.senderIdentity ?? '',
        templateVersionId,
      });

      if (result.status === 'SENT') {
        latestAttempt = await this.attemptRepository.updateAttempt(newAttempt.attemptId, {
          status: 'DELIVERED',
          channelMessageId: result.channelMessageId,
          completedAt: new Date().toISOString(),
        });
      } else if (result.status === 'BOUNCE') {
        latestAttempt = await this.attemptRepository.updateAttempt(newAttempt.attemptId, {
          status: 'PERMANENT_FAILURE',
          responseCategory: 'BOUNCE',
          sanitizedError: result.sanitizedError,
          completedAt: new Date().toISOString(),
        });
      } else {
        // TEMPORARY_FAILURE / UNCERTAIN：进入失败重试，记录首次失败时间（NTF-007）
        latestAttempt = await this.attemptRepository.updateAttempt(newAttempt.attemptId, {
          status: 'FAILED_RETRY',
          responseCategory:
            result.status === 'UNCERTAIN' ? ('UNCERTAIN' as const) : ('TEMPORARY_FAILURE' as const),
          firstFailedAt: now,
          sanitizedError: result.sanitizedError,
          nextRetryAt: computeNextRetryAt(1, now),
        });
      }
    } catch (error) {
      latestAttempt = await this.attemptRepository.updateAttempt(newAttempt.attemptId, {
        status: 'FAILED_RETRY',
        responseCategory: 'TEMPORARY_FAILURE' as const,
        firstFailedAt: now,
        sanitizedError: (error as Error).message,
        nextRetryAt: computeNextRetryAt(1, now),
      });
    }

    this.logger.log(`人工补发完成: factId=${factId}, targetEmail=${targetEmail}`);
    return latestAttempt;
  }
}
