import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TaskIntent } from '../contracts';
import type { TransactionOutboxStore } from './transactional-outbox';
import { TASK_OUTBOX_STORE } from './transactional-outbox';

@Injectable()
export class TaskIntentOutbox {
  private readonly logger = new Logger(TaskIntentOutbox.name);

  constructor(
    @Inject(TASK_OUTBOX_STORE)
    private readonly store: TransactionOutboxStore,
  ) {}

  async register(intent: TaskIntent): Promise<void> {
    await this.store.append(intent);
  }

  async forwardPending(
    limit: number,
    sink: (intent: TaskIntent) => Promise<void>,
  ): Promise<number> {
    const pending = await this.store.listPending(limit);
    let forwarded = 0;
    for (const intent of pending) {
      try {
        await sink(intent);
      } catch (err) {
        // 单个意图落库/转发失败，保留为待转发状态待下轮重试，不中断整轮调度
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `outbox 意图转发失败，保留待下轮重试：intentId=${intent.intentId}, reason=${reason}`,
        );
        continue;
      }
      await this.store.markForwarded(intent.intentId);
      forwarded += 1;
    }
    return forwarded;
  }
}
