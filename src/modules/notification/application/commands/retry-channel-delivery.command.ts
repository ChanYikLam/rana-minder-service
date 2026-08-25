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
import { MarkPermanentFailureCommand } from './mark-permanent-failure.command';

@Injectable()
export class RetryChannelDeliveryCommand {
  private readonly logger = new Logger(RetryChannelDeliveryCommand.name);

  constructor(
    @Inject(CHANNEL_DELIVERY_ATTEMPT_REPOSITORY)
    private readonly attemptRepository: ChannelDeliveryAttemptRepository,
    @Inject(EMAIL_ADAPTER)
    private readonly emailAdapter: EmailAdapter,
    // 永久失败统一走 MarkPermanentFailureCommand：承担 NTF-007
    // 站内信提示用户＋特权审计通知管理员义务（重试路径不再绕过）
    private readonly markPermanentFailure: MarkPermanentFailureCommand,
  ) {}

  /**
   * 重试失败的渠道投递。
   * 明确退信或连续失败 24 小时后停止重试（NTF-007）。
   * 重试不重执行原业务（NTF-001）。
   *
   * @param attemptId 待重试的渠道投递尝试标识
   */
  async execute(attemptId: string): Promise<void> {
    // 原子抢占（W1）：仅 FAILED_RETRY 可被本 worker 抢占为 PENDING；
    // 已被其他实例/worker 抢占（返回 null）时直接放弃，避免并发重复发送
    const attempt = await this.attemptRepository.claimForRetry(attemptId);
    if (!attempt) {
      this.logger.warn(`投递尝试不可抢占（不存在或不在 FAILED_RETRY）: attemptId=${attemptId}`);
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
      // 进入永久失败（NTF-007）：统一走 MarkPermanentFailureCommand
      // 以承担站内信提示用户＋通知管理员义务
      await this.markPermanentFailure.execute(attemptId);
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
      } else if (result.status === 'BOUNCE') {
        // 明确退信：立即进入永久失败，不再重试（NTF-007）；
        // 统一走 MarkPermanentFailureCommand 以承担提示义务并保留退信类别
        await this.markPermanentFailure.execute(attemptId, {
          responseCategory: 'BOUNCE',
          sanitizedError: result.sanitizedError,
        });
        this.logger.log(`投递重试遇明确退信，进入永久失败: attemptId=${attemptId}`);
      } else {
        // TEMPORARY_FAILURE / UNCERTAIN：继续失败重试（NTF-007）
        const nextNumber = attempt.attemptNumber + 1;
        const now = new Date().toISOString();
        await this.attemptRepository.updateAttempt(attemptId, {
          attemptNumber: nextNumber,
          status: 'FAILED_RETRY',
          responseCategory: result.status === 'UNCERTAIN' ? 'UNCERTAIN' : 'TEMPORARY_FAILURE',
          firstFailedAt: attempt.firstFailedAt ?? now,
          sanitizedError: result.sanitizedError,
          // 本次为第 nextNumber 次尝试，退避 2^N 递增（NTF-007）
          nextRetryAt: computeNextRetryAt(nextNumber, now),
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
        nextRetryAt: computeNextRetryAt(nextNumber, now),
      });
    }
  }
}
