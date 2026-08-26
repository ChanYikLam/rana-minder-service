import { Inject, Injectable, Logger } from '@nestjs/common';
import { RANA_MINDER_CONFIG, type RanaMinderConfig } from '../../../config';
import type { TaskIntent } from '../contracts';
import { TASK_OUTBOX_STORE, type TransactionOutboxStore } from './transactional-outbox';

@Injectable()
export class TaskIntentOutbox {
  private readonly logger = new Logger(TaskIntentOutbox.name);

  constructor(
    @Inject(TASK_OUTBOX_STORE) private readonly store: TransactionOutboxStore,
    @Inject(RANA_MINDER_CONFIG)
    private readonly config: RanaMinderConfig = { job: { maxAttempts: 5 } } as RanaMinderConfig,
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
        // 单个意图落库/转发失败：累加失败计数，达到上限由存储置死信；
        // 未达上限保留为待转发状态待下轮重试，不中断整轮调度。
        const reason = err instanceof Error ? err.message : String(err);
        // 可重试故障按 error 级别记录，确保可观测与告警（BUG-014 修复）
        this.logger.error(
          `outbox 意图转发失败，保留待下轮重试：intentId=${intent.intentId}, reason=${reason}`,
        );
        await this.store.markFailed(intent.intentId, this.config.job.maxAttempts);
        continue;
      }
      await this.store.markForwarded(intent.intentId);
      forwarded += 1;
    }
    return forwarded;
  }
}
