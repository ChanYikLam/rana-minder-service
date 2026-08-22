/**
 * 全部标记已读命令（NTF-003、SRS-SM-NTF-001 转换 5b）。
 *
 * 收件人本人将全部未读站内信标记为已读，逐条幂等；
 * 不影响已处理/已隐藏通知。
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { InboxAdapter } from '../../infrastructure';
import { INBOX_ADAPTER } from '../../tokens';

export interface MarkAllReadResult {
  readonly updatedCount: number;
}

@Injectable()
export class MarkAllReadCommand {
  private readonly logger = new Logger(MarkAllReadCommand.name);

  constructor(
    @Inject(INBOX_ADAPTER)
    private readonly inboxAdapter: InboxAdapter,
  ) {}

  async execute(recipientId: string): Promise<MarkAllReadResult> {
    const updatedCount = await this.inboxAdapter.markAllRead(recipientId);
    this.logger.log(`收件人 ${recipientId} 全部标记已读: ${updatedCount} 条`);
    return { updatedCount };
  }
}
