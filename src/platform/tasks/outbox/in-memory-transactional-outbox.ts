import { Injectable, Logger } from '@nestjs/common';
import type { TaskIntent } from '../contracts';
import type { TransactionOutboxStore } from './transactional-outbox';

@Injectable()
export class InMemoryTransactionOutboxStore implements TransactionOutboxStore {
  private readonly logger = new Logger(InMemoryTransactionOutboxStore.name);
  private readonly records = new Map<string, TaskIntent>();
  private readonly forwarded = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private readonly deadLettered = new Set<string>();

  async append(intent: TaskIntent): Promise<void> {
    if (this.records.has(intent.intentId)) {
      this.logger.debug(`outbox 意图已存在，幂等忽略：intentId=${intent.intentId}`);
      return;
    }
    this.records.set(intent.intentId, intent);
    this.logger.debug(
      `outbox 已登记任务意图：intentId=${intent.intentId}, type=${intent.taskType}`,
    );
  }

  async listPending(limit: number): Promise<readonly TaskIntent[]> {
    const pending: TaskIntent[] = [];
    for (const [id, intent] of this.records) {
      if (pending.length >= limit) break;
      if (this.forwarded.has(id) || this.deadLettered.has(id)) continue;
      pending.push(intent);
    }
    return pending;
  }

  async markForwarded(intentId: string): Promise<void> {
    if (this.records.has(intentId) === false) {
      this.logger.warn(`outbox 转发标记失败：意图不存在 intentId=${intentId}`);
      return;
    }
    this.forwarded.add(intentId);
  }

  async markFailed(intentId: string, maxAttempts = 5): Promise<void> {
    if (this.records.has(intentId) === false) {
      this.logger.warn(`outbox 失败标记失败：意图不存在 intentId=${intentId}`);
      return;
    }
    const next = (this.attempts.get(intentId) ?? 0) + 1;
    this.attempts.set(intentId, next);
    if (next >= maxAttempts) {
      // 达到重试上限：置死信，停止参与后续调度，待人工介入。
      this.deadLettered.add(intentId);
      this.logger.error(
        `outbox 意图达到重试上限转入死信（人工介入）：intentId=${intentId}, attempts=${next}/${maxAttempts}`,
      );
    }
  }
}
