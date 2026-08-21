/**
 * 渠道投递重试命令（NTF-001、NTF-007、IFC-TX-005）。
 *
 * 持续重试失败投递；重试只重发通知，不重执行原业务。
 */

import { Injectable, Logger } from '@nestjs/common';
import type { ChannelDeliveryAttemptRepository, EmailAdapter } from '../../infrastructure';
import { shouldStopEmailRetry } from '../../domain';

@Injectable()
export class RetryChannelDeliveryCommand {
  private readonly logger = new Logger(RetryChannelDeliveryCommand.name);

  constructor(
    private readonly attemptRepository: ChannelDeliveryAttemptRepository,
    private readonly emailAdapter: EmailAdapter,
  ) {}

  /**
   * 重试失败的渠道投递。
   * 明确退信或连续失败 24 小时后停止重试（NTF-007）。
   * 重试不重执行原业务（NTF-001）。
   */
  async execute(attemptId: string): Promise<void> {
    const attempts = await this.attemptRepository.findRetryableAttempts(1);
    const attempt = attempts.find((a) => a.attemptId === attemptId);
    if (!attempt) {
      this.logger.warn(`无可重试的投递尝试: ${attemptId}`);
      return;
    }

    // 判断是否应停止重试
    if (
      shouldStopEmailRetry({
        responseCategory: attempt.responseCategory ?? 'TEMPORARY_FAILURE',
        firstFailureAt: attempt.createdAt,
        now: new Date().toISOString(),
      })
    ) {
      // 进入永久失败（NTF-007）
      await this.attemptRepository.updateAttempt(attemptId, {
        status: 'PERMANENT_FAILURE',
        completedAt: new Date().toISOString(),
      });
      this.logger.log(`投递进入永久失败: attemptId=${attemptId}`);
      return;
    }

    // 重发通知（不重执行原业务）
    try {
      const result = await this.emailAdapter.send({
        to: attempt.targetAddress ?? '',
        subject: '重发通知',
        body: '',
        senderIdentity: attempt.senderIdentity ?? '',
        templateVersionId: attempt.templateVersionId,
      });

      if (result.status === 'SENT') {
        await this.attemptRepository.updateAttempt(attemptId, {
          status: 'DELIVERED',
          channelMessageId: result.channelMessageId,
          completedAt: new Date().toISOString(),
        });
        this.logger.log(`投递重试成功: attemptId=${attemptId}`);
      } else {
        const nextNumber = attempt.attemptNumber + 1;
        await this.attemptRepository.updateAttempt(attemptId, {
          attemptNumber: nextNumber,
          status: 'FAILED_RETRY',
          sanitizedError: result.sanitizedError,
          nextRetryAt: this.calculateNextRetry(nextNumber),
        });
      }
    } catch (error) {
      const nextNumber = attempt.attemptNumber + 1;
      await this.attemptRepository.updateAttempt(attemptId, {
        attemptNumber: nextNumber,
        status: 'FAILED_RETRY',
        sanitizedError: (error as Error).message,
        nextRetryAt: this.calculateNextRetry(nextNumber),
      });
    }
  }

  private calculateNextRetry(attemptNumber: number): string {
    const minutes = Math.min(2 ** attemptNumber, 60 * 6);
    return new Date(Date.now() + minutes * 60 * 1000).toISOString();
  }
}
