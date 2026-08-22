/**
 * 站内信紧急关闭/暂停投递命令（NTF-001、SRS-FAIL-009）。
 *
 * 超级管理员紧急关闭站内信时，通知事实仍必须保存；
 * 关闭期间如何展示和恢复补投按 SRS-FAIL-009 处理。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { NotificationRepository } from '../../infrastructure';
import { NotificationStateMachine } from '../../domain';
import { NOTIFICATION_REPOSITORY } from '../../tokens';

export interface PauseInboxResult {
  readonly pausedFactCount: number;
}

@Injectable()
export class PauseInboxCommand {
  private readonly logger = new Logger(PauseInboxCommand.name);
  private readonly stateMachine = new NotificationStateMachine();

  constructor(
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repository: NotificationRepository,
  ) {}

  /**
   * 暂停站内信投递。
   * 已成功投递的保持投递状态；未投递的进入暂停投递。
   */
  async execute(factIds: readonly string[]): Promise<PauseInboxResult> {
    let pausedCount = 0;

    for (const factId of factIds) {
      const fact = await this.repository.findFactById(factId);
      if (!fact) continue;

      const transition = this.stateMachine.evaluate({
        type: 'KILL_INBOX',
        currentStatus: fact.status,
        currentChannelStatus: fact.status === 'CREATED_PENDING_DELIVERY' ? 'PENDING' : undefined,
      });

      if (!transition.allowed) {
        this.logger.log(`通知 ${factId} 不进入暂停: ${transition.reason}`);
        continue;
      }

      await this.repository.updateFactStatus(factId, 'CREATED_PAUSED_DELIVERY', fact.version);
      pausedCount += 1;
    }

    this.logger.log(`站内信暂停投递完成: 暂停 ${pausedCount} 条`);
    return { pausedFactCount: pausedCount };
  }
}
