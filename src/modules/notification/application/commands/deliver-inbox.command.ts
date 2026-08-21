/**
 * 站内信投递命令（NTF-001、NTF-003、SRS-SM-NTF-001 转换 4）。
 *
 * 由后台任务调度器调用。同一逻辑事件＋收件人只对应一条站内信。
 * 投递失败进入失败重试，不回滚已生效业务。
 */

import { Injectable, Logger } from '@nestjs/common';
import type {
  ChannelDeliveryAttemptRepository,
  InboxAdapter,
  NotificationRepository,
} from '../../infrastructure';
import {
  type ChannelDeliveryAttemptModel,
  type RecipientSnapshot,
  NotificationStateMachine,
} from '../../domain';

@Injectable()
export class DeliverInboxCommand {
  private readonly logger = new Logger(DeliverInboxCommand.name);
  private readonly stateMachine = new NotificationStateMachine();

  constructor(
    private readonly repository: NotificationRepository,
    private readonly inboxAdapter: InboxAdapter,
    private readonly attemptRepository: ChannelDeliveryAttemptRepository,
  ) {}

  /**
   * 投递站内信到指定收件人。
   * 渠道投递失败不回滚已生效业务（NTF-001、IFC-TX-005）。
   *
   * @param factId 通知事实标识
   * @param expectedVersion 乐观锁版本
   * @returns 投递结果
   */
  async execute(factId: string, expectedVersion: number): Promise<{ presentationCount: number }> {
    const fact = await this.repository.findFactById(factId);
    if (!fact) {
      this.logger.warn(`通知事实不存在: ${factId}`);
      return { presentationCount: 0 };
    }

    // 状态机校验：已创建＋待投递 → 已投递
    const transition = this.stateMachine.evaluate({
      type: 'DELIVER_INBOX',
      currentStatus: fact.status,
    });

    if (!transition.allowed) {
      this.logger.warn(`站内信投递拒绝: factId=${factId}, reason=${transition.reason}`);
      return { presentationCount: 0 };
    }

    try {
      // 按收件人快照创建/确认唯一站内信呈现（逻辑事件＋收件人唯一，NTF-003）
      const snapshots = await this.repository.findSnapshotsByFactId(factId);
      for (const snapshot of snapshots) {
        await this.inboxAdapter.createOrConfirmPresentation(fact, snapshot);
      }

      await this.repository.updateFactStatus(factId, 'DELIVERED', expectedVersion);
      this.logger.log(`站内信投递成功: factId=${factId}, 呈现=${snapshots.length} 条`);
      return { presentationCount: snapshots.length };
    } catch (error) {
      // 临时失败：记录失败重试尝试，接入重试队列；不回滚业务（NTF-001、IFC-TX-005）
      const snapshots = await this.repository
        .findSnapshotsByFactId(factId)
        .catch(() => [] as readonly RecipientSnapshot[]);
      const now = new Date().toISOString();
      for (const snapshot of snapshots) {
        await this.recordInboxFailure(factId, snapshot, (error as Error).message, now);
      }
      this.logger.error(`站内信投递临时失败: factId=${factId}, error=${(error as Error).message}`);
      return { presentationCount: 0 };
    }
  }

  /**
   * 记录站内信投递失败尝试，供重试队列拉取（NTF-007、IFC-TX-005）。
   */
  private async recordInboxFailure(
    factId: string,
    snapshot: RecipientSnapshot,
    error: string,
    now: string,
  ): Promise<void> {
    const attempt: ChannelDeliveryAttemptModel = {
      attemptId: `inbox-attempt-${factId}-${snapshot.recipientId}-${Date.now()}`,
      factId,
      snapshotId: snapshot.snapshotId,
      channel: 'INBOX',
      channelMessageId: null,
      attemptNumber: 1,
      status: 'FAILED_RETRY',
      targetAddress: null,
      templateVersionId: null,
      senderIdentity: null,
      responseCategory: 'TEMPORARY_FAILURE',
      sanitizedError: error,
      nextRetryAt: this.calculateNextRetry(1),
      createdAt: now,
      completedAt: null,
      version: 1,
    };
    await this.attemptRepository.saveAttempt(attempt);
  }

  private calculateNextRetry(attemptNumber: number): string {
    const minutes = Math.min(2 ** attemptNumber, 60 * 6); // 指数退避，最多 6 小时
    return new Date(Date.now() + minutes * 60 * 1000).toISOString();
  }
}
