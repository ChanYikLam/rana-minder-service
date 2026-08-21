/**
 * 永久失败标记命令（NTF-007、SRS-SM-NTF-001 转换 9）。
 *
 * 明确退信或连续失败 24 小时后进入永久失败并保留投递证据。
 */

import { Injectable, Logger } from '@nestjs/common';
import type { ChannelDeliveryAttemptRepository } from '../../infrastructure';
import { NotificationStateMachine } from '../../domain';

@Injectable()
export class MarkPermanentFailureCommand {
  private readonly logger = new Logger(MarkPermanentFailureCommand.name);
  private readonly stateMachine = new NotificationStateMachine();

  constructor(private readonly attemptRepository: ChannelDeliveryAttemptRepository) {}

  /**
   * 标记永久失败。
   * 每个任务只进入一次永久失败；人工重发新建尝试（NTF-007）。
   */
  async execute(attemptId: string): Promise<void> {
    const attempts = await this.attemptRepository.findRetryableAttempts(100);
    const attempt = attempts.find((a) => a.attemptId === attemptId);
    if (!attempt) {
      this.logger.warn(`无可标记为永久失败的尝试: ${attemptId}`);
      return;
    }

    const transition = this.stateMachine.evaluate({
      type: 'MARK_PERMANENT_FAILURE',
      currentStatus: 'CREATED_PENDING_DELIVERY',
      currentChannelStatus: attempt.status,
      channel: attempt.channel,
    });

    if (!transition.allowed) {
      this.logger.log(`尝试 ${attemptId} 不可标记永久失败: ${transition.reason}`);
      return;
    }

    await this.attemptRepository.updateAttempt(attemptId, {
      status: 'PERMANENT_FAILURE',
      completedAt: new Date().toISOString(),
    });

    this.logger.log(`投递尝试标记永久失败: attemptId=${attemptId}`);
  }
}
