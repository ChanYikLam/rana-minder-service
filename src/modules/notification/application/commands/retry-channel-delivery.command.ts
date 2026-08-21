/**
 * 渠道投递重试命令（NTF-001、NTF-007、IFC-TX-005）。
 *
 * 持续重试失败投递；重试只重发通知，不重执行原业务。
 * 按尝试标识直接定位待重试尝试（不依赖队首顺序），
 * 只有处于失败重试状态的尝试才允许重试。
 *
 * 停止重试的 24 小时窗口从首次失败时刻（firstFailedAt）起算（NTF-007）；
 * 重发内容复用创建时冻结的邮件标题/正文快照（NTF-002 最少摘要），
 * 不产生空邮件。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ChannelDeliveryAttemptRepository, EmailAdapter } from '../../infrastructure';
import { computeNextRetryAt, shouldStopEmailRetry } from '../../domain';
import { CHANNEL_DELIVERY_ATTEMPT_REPOSITORY, EMAIL_ADAPTER } from '../../tokens';

@Injectable()
export class RetryChannelDeliveryCommand {
  private readonly logger = new Logger(RetryChannelDeliveryCommand.name);

  constructor(
    @Inject(CHANNEL_DELIVERY_ATTEMPT_REPOSITORY)
    private readonly attemptRepository: ChannelDeliveryAttemptRepository,
    @Inject(EMAIL_ADAPTER)
    private readonly emailAdapter: EmailAdapter,
  ) {}

  /**
   * 重试失败的渠道投递。
   * 明确退信或连续失败 24 小时后停止重试（NTF-007）。
   * 重试不重执行原业务（NTF-001）。
   *
   * @param attemptId 待重试的渠道投递尝试标识
   */
  async execute(attemptId: string): Promise<void> {
    const attempt = await this.attemptRepository.findAttemptById(attemptId);
    if (!attempt) {
      this.logger.warn(`投递尝试不存在: ${attemptId}`);
      return;
    }
    if (attempt.status !== 'FAILED_RETRY') {
      this.logger.warn(`投递尝试不在可重试状态: attemptId=${attemptId}, status=${attempt.status}`);
      return;
    }

    // 判断是否应停止重试（窗口从首次失败时刻起算，NTF-007）
    if (
      shouldStopEmailRetry({
        responseCategory: attempt.responseCategory ?? 'TEMPORARY_FAILURE',
        firstFailureAt: attempt.firstFailedAt ?? attempt.createdAt,
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

    // 重发通知（不重执行原业务）；内容复用创建时冻结的快照，避免空邮件（NTF-002）
    try {
      const result = await this.emailAdapter.send({
        to: attempt.targetAddress ?? '',
        subject: attempt.emailSubject ?? '重发通知',
        body: attempt.emailBody ?? '',
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
        const now = new Date().toISOString();
        await this.attemptRepository.updateAttempt(attemptId, {
          attemptNumber: nextNumber,
          status: 'FAILED_RETRY',
          firstFailedAt: attempt.firstFailedAt ?? now,
          sanitizedError: result.sanitizedError,
          // 刚失败的尝试序号 = attempt.attemptNumber，退避 2^N 递增
          nextRetryAt: computeNextRetryAt(attempt.attemptNumber, now),
        });
      }
    } catch (error) {
      const nextNumber = attempt.attemptNumber + 1;
      const now = new Date().toISOString();
      await this.attemptRepository.updateAttempt(attemptId, {
        attemptNumber: nextNumber,
        status: 'FAILED_RETRY',
        firstFailedAt: attempt.firstFailedAt ?? now,
        sanitizedError: (error as Error).message,
        nextRetryAt: computeNextRetryAt(attempt.attemptNumber, now),
      });
    }
  }
}
