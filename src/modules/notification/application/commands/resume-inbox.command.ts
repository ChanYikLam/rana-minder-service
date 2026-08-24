/**
 * 站内信恢复命令（NTF-001、SRS-FAIL-009、IFC-NTF-001）。
 *
 * 恢复后按原事件时间升序补投暂停期间通知；
 * 恢复只补投渠道，不重复执行业务。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { NotificationRepository } from '../../infrastructure';
import { NotificationStateMachine } from '../../domain';
import { NOTIFICATION_REPOSITORY } from '../../tokens';

export interface ResumeInboxResult {
  readonly resumedFactCount: number;
}

@Injectable()
export class ResumeInboxCommand {
  private readonly logger = new Logger(ResumeInboxCommand.name);
  private readonly stateMachine = new NotificationStateMachine();

  constructor(
    @Inject(NOTIFICATION_REPOSITORY)
    private readonly repository: NotificationRepository,
  ) {}

  /**
   * 恢复站内信投递。
   * 恢复后按原事件时间排队投递，不重复原业务（NTF-001、IFC-NTF-001）。
   */
  async execute(factIds: readonly string[]): Promise<ResumeInboxResult> {
    let resumedCount = 0;

    for (const factId of factIds) {
      const fact = await this.repository.findFactById(factId);
      if (!fact) continue;

      const transition = this.stateMachine.evaluate({
        type: 'RESUME_INBOX',
        currentStatus: fact.status,
      });

      if (!transition.allowed) {
        this.logger.log(`通知 ${factId} 不恢复: ${transition.reason}`);
        continue;
      }

      await this.repository.updateFactStatus(factId, 'CREATED_PENDING_DELIVERY', fact.version);
      resumedCount += 1;
    }

    this.logger.log(`站内信恢复投递完成: 恢复 ${resumedCount} 条`);
    return { resumedFactCount: resumedCount };
  }
}
