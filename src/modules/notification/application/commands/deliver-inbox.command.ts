/**
 * 站内信投递命令（NTF-001、NTF-003、SRS-SM-NTF-001 转换 4）。
 *
 * 由后台任务调度器调用。同一逻辑事件＋收件人只对应一条站内信；
 * 按收件人快照创建唯一呈现记录。投递失败进入失败重试，
 * 不回滚已生效业务。
 */

import { Injectable, Logger } from '@nestjs/common';
import type { InboxAdapter, NotificationRepository } from '../../infrastructure';
import { NotificationStateMachine } from '../../domain';

@Injectable()
export class DeliverInboxCommand {
  private readonly logger = new Logger(DeliverInboxCommand.name);
  private readonly stateMachine = new NotificationStateMachine();

  constructor(
    private readonly repository: NotificationRepository,
    private readonly inboxAdapter: InboxAdapter,
  ) {}

  /**
   * 投递站内信到指定收件人。
   * 渠道投递失败不回滚已生效业务（NTF-001、IFC-TX-005）。
   *
   * @param factId 通知事实标识
   * @param expectedVersion 乐观锁版本
   * @returns 投递结果（呈现条数）
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
      // 临时失败：进入失败重试，不回滚业务（NTF-001、IFC-TX-005）
      this.logger.error(`站内信投递临时失败: factId=${factId}, error=${(error as Error).message}`);
      return { presentationCount: 0 };
    }
  }
}
