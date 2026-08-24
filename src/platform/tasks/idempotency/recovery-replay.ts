import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TaskRecord } from '../contracts';
import { IdempotencyRecordStatus } from './idempotency-record';
import { IDEMPOTENCY_STORE, type IdempotencyStore } from './idempotency-store';

@Injectable()
export class RecoveryReplayConvergence {
  private readonly logger = new Logger(RecoveryReplayConvergence.name);

  constructor(@Inject(IDEMPOTENCY_STORE) private readonly idempotency: IdempotencyStore) {}

  async convergeBeforeExecution(
    task: TaskRecord,
    now: Date,
  ): Promise<{ allowed: boolean; resultRef?: string }> {
    const record = await this.idempotency.find(task.idempotencyKey);
    if (record === null) {
      // 首次执行：以本次领取租约的到期时刻作为执行任期，供崩溃恢复判定超时。
      const begun = await this.idempotency.begin(
        task.idempotencyKey,
        task.intentId,
        task.lease?.leaseUntil ?? now.toISOString(),
      );
      return { allowed: begun };
    }
    if (record.status === IdempotencyRecordStatus.COMPLETED) {
      return { allowed: false, resultRef: record.resultRef ?? undefined };
    }
    if (record.status === IdempotencyRecordStatus.EXECUTING) {
      // BUG-004 修复：恢复判定基于幂等记录自身声明的执行任期（executingUntil），
      // 而非任务表"当前行"租约。崩溃后任务被重新领取会得到全新租约，若取当前行
      // 租约会永远未过期，导致 EXECUTING 任务在 LEASED↔PENDING 间死循环、恢复不可达。
      const until = record.executingUntil;
      const stale =
        until === null || until === undefined || new Date(until).getTime() <= now.getTime();
      if (stale) {
        this.logger.warn(
          `恢复重放：执行中幂等记录对应任期已超时，允许重放：idempotencyKey=${task.idempotencyKey}`,
        );
        return { allowed: true };
      }
      return { allowed: false };
    }
    return { allowed: true };
  }

  async convergeAfterSuccess(task: TaskRecord, resultRef: string): Promise<void> {
    await this.idempotency.complete(task.idempotencyKey, task.intentId, resultRef);
  }

  async convergeAfterFailure(task: TaskRecord): Promise<void> {
    await this.idempotency.fail(task.idempotencyKey, task.intentId);
  }
}
