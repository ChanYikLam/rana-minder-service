import { Injectable } from '@nestjs/common';
import type { TaskIntent } from '../contracts';
import type { TransactionOutboxStore } from './transactional-outbox';

@Injectable()
export class TaskIntentOutbox {
  constructor(private readonly store: TransactionOutboxStore) {}

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
      await sink(intent);
      await this.store.markForwarded(intent.intentId);
      forwarded += 1;
    }
    return forwarded;
  }
}
