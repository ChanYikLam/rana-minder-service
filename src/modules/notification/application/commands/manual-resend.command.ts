/**
 * 人工补发命令（NTF-007、SRS-SM-NTF-001 转换 10）。
 *
 * 人工重发只重发通知，不重执行原业务。
 * 新建关联原通知事实的邮件尝试，旧投递记录保留。
 */

import { Injectable, Logger } from '@nestjs/common';
import type {
  ChannelDeliveryAttemptRepository,
  EmailAdapter,
  NotificationRepository,
  TemplateSnapshotService,
} from '../../infrastructure';
import type { ChannelDeliveryAttemptModel } from '../../domain';
import { NotificationStateMachine } from '../../domain';

@Injectable()
export class ManualResendCommand {
  private readonly logger = new Logger(ManualResendCommand.name);
  private readonly stateMachine = new NotificationStateMachine();

  constructor(
    private readonly repository: NotificationRepository,
    private readonly attemptRepository: ChannelDeliveryAttemptRepository,
    private readonly emailAdapter: EmailAdapter,
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

    const now = new Date().toISOString();
    const newAttempt: ChannelDeliveryAttemptModel = {
      attemptId: `manual-resend-${factId}-${Date.now()}`,
      factId,
      snapshotId: '',
      channel: 'EMAIL',
      channelMessageId: null,
      attemptNumber: 1,
      status: 'PENDING',
      targetAddress: targetEmail,
      templateVersionId,
      senderIdentity: fact.scope.type === 'CLUB' ? fact.scope.clubId : 'platform',
      responseCategory: null,
      sanitizedError: null,
      nextRetryAt: null,
      createdAt: now,
      completedAt: null,
      version: 1,
    };

    await this.attemptRepository.saveAttempt(newAttempt);

    try {
      const result = await this.emailAdapter.send({
        to: targetEmail,
        subject: fact.summary.slice(0, 100),
        body: fact.summary,
        senderIdentity: newAttempt.senderIdentity ?? '',
        templateVersionId,
      });

      if (result.status === 'SENT') {
        await this.attemptRepository.updateAttempt(newAttempt.attemptId, {
          status: 'DELIVERED',
          channelMessageId: result.channelMessageId,
          completedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      await this.attemptRepository.updateAttempt(newAttempt.attemptId, {
        status: 'FAILED_RETRY',
        sanitizedError: (error as Error).message,
      });
    }

    this.logger.log(`人工补发完成: factId=${factId}, targetEmail=${targetEmail}`);
    return newAttempt;
  }
}
