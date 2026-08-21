/**
 * 邮件投递命令（NTF-004 至 NTF-007、SRS-SM-NTF-001 转换 6/7）。
 *
 * 邮件是可选附加渠道。邮件资格判定：事件允许邮件、
 * 本次/活动配置未关闭、用户未退订、邮箱已验证、发信账号有效。
 * 邮件失败不回滚业务；临时失败自动重试；
 * 明确退信或连续失败 24 小时后停止重试。
 */

import { Injectable, Logger } from '@nestjs/common';
import type {
  ChannelDeliveryAttemptRepository,
  EmailAdapter,
  NotificationRepository,
  TemplateSnapshotService,
} from '../../infrastructure';
import {
  type ChannelDeliveryAttemptModel,
  evaluateEmailEligibility,
  NotificationStateMachine,
} from '../../domain';

@Injectable()
export class CreateEmailAttemptCommand {
  private readonly logger = new Logger(CreateEmailAttemptCommand.name);
  private readonly stateMachine = new NotificationStateMachine();

  constructor(
    private readonly repository: NotificationRepository,
    private readonly attemptRepository: ChannelDeliveryAttemptRepository,
    private readonly emailAdapter: EmailAdapter,
    private readonly templateService: TemplateSnapshotService,
  ) {}

  /**
   * 评估邮件资格并创建邮件投递任务。
   * 不具资格时不创建邮件，通知事实保持（NTF-004 至 NTF-007）。
   */
  async execute(input: {
    readonly factId: string;
    readonly recipientId: string;
    readonly recipientEmail: string;
    readonly eventAllowsEmail: boolean;
    readonly configClosedEmail: boolean;
    readonly userUnsubscribed: boolean;
    readonly emailVerified: boolean;
    readonly senderAccountValid: boolean;
    readonly eventType: string;
  }): Promise<ChannelDeliveryAttemptModel | null> {
    const eligibility = evaluateEmailEligibility({
      eventAllowsEmail: input.eventAllowsEmail,
      configClosedEmail: input.configClosedEmail,
      userUnsubscribed: input.userUnsubscribed,
      emailVerified: input.emailVerified,
      senderAccountValid: input.senderAccountValid,
    });

    if (!eligibility.eligible) {
      this.logger.log(
        `邮件资格不满足: factId=${input.factId}, ` +
          `recipientId=${input.recipientId}, reason=${eligibility.reason}`,
      );
      return null;
    }

    const fact = await this.repository.findFactById(input.factId);
    if (!fact) {
      this.logger.warn(`通知事实不存在: ${input.factId}`);
      return null;
    }

    // 冻结模板版本
    const templateVersionId = await this.templateService.snapshotTemplate(input.eventType, 'EMAIL');

    const now = new Date().toISOString();
    const attempt: ChannelDeliveryAttemptModel = {
      attemptId: `email-attempt-${input.factId}-${input.recipientId}-${Date.now()}`,
      factId: input.factId,
      snapshotId: '', // 关联收件人快照
      channel: 'EMAIL',
      channelMessageId: null,
      attemptNumber: 1,
      status: 'PENDING',
      targetAddress: input.recipientEmail,
      templateVersionId,
      senderIdentity: fact.scope.type === 'CLUB' ? fact.scope.clubId : 'platform',
      responseCategory: null,
      sanitizedError: null,
      nextRetryAt: null,
      createdAt: now,
      completedAt: null,
      version: 1,
    };

    await this.attemptRepository.saveAttempt(attempt);

    // 发送邮件
    let latestAttempt: ChannelDeliveryAttemptModel = attempt;
    try {
      const result = await this.emailAdapter.send({
        to: input.recipientEmail,
        subject: fact.summary.slice(0, 100),
        body: fact.summary,
        senderIdentity: attempt.senderIdentity ?? '',
        templateVersionId,
      });

      if (result.status === 'SENT') {
        latestAttempt = await this.attemptRepository.updateAttempt(attempt.attemptId, {
          status: 'DELIVERED',
          channelMessageId: result.channelMessageId,
          completedAt: new Date().toISOString(),
        });
      } else if (result.status === 'TEMPORARY_FAILURE') {
        latestAttempt = await this.attemptRepository.updateAttempt(attempt.attemptId, {
          status: 'FAILED_RETRY',
          sanitizedError: result.sanitizedError,
          nextRetryAt: this.calculateNextRetry(1),
        });
      } else if (result.status === 'BOUNCE') {
        latestAttempt = await this.attemptRepository.updateAttempt(attempt.attemptId, {
          status: 'PERMANENT_FAILURE',
          responseCategory: 'BOUNCE',
          sanitizedError: result.sanitizedError,
          completedAt: new Date().toISOString(),
        });
      } else {
        // UNCERTAIN：等待回读
        latestAttempt = await this.attemptRepository.updateAttempt(attempt.attemptId, {
          status: 'FAILED_RETRY',
          responseCategory: 'UNCERTAIN',
          sanitizedError: '结果不确定，等待回读',
          nextRetryAt: this.calculateNextRetry(1),
        });
      }
    } catch (error) {
      // 临时失败：进入重试（NTF-007）
      latestAttempt = await this.attemptRepository.updateAttempt(attempt.attemptId, {
        status: 'FAILED_RETRY',
        sanitizedError: (error as Error).message,
        nextRetryAt: this.calculateNextRetry(1),
      });
    }

    return latestAttempt;
  }

  private calculateNextRetry(attemptNumber: number): string {
    const minutes = Math.min(2 ** attemptNumber, 60 * 6); // 指数退避，最多 6 小时
    return new Date(Date.now() + minutes * 60 * 1000).toISOString();
  }
}
