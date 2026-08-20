import { Injectable, Logger } from '@nestjs/common';
import type { TaskRecord, TaskRepository } from '../contracts';
import { IdempotencyRecordStatus } from './idempotency-record';
import type { IdempotencyStore } from './idempotency-store';

@Injectable()
export class RecoveryReplayConvergence {
  private readonly logger = new Logger(RecoveryReplayConvergence.name);

  constructor(
    private readonly repository: TaskRepository,
    private readonly idempotency: IdempotencyStore,
  ) {}

  async convergeBeforeExecution(
    task: TaskRecord,
  ): Promise<{ allowed: boolean; resultRef?: string }> {
    const record = await this.idempotency.find(task.idempotencyKey);
    if (record === null) {
      const begun = await this.idempotency.begin(task.idempotencyKey, task.intentId);
      return { allowed: begun };
    }
    if (record.status === IdempotencyRecordStatus.COMPLETED) {
      return { allowed: false, resultRef: record.resultRef ?? undefined };
    }
    if (record.status === IdempotencyRecordStatus.EXECUTING) {
      const fresh = await this.repository.findByIntentId(task.intentId);
      const leaseExpired =
        fresh === null ||
        fresh.lease === null ||
        new Date(fresh.lease.leaseUntil).getTime() <= Date.now();
      if (leaseExpired === false) return { allowed: false };
      this.logger.warn(
        `恢复重放：执行中幂等记录对应任务租约已过期：idempotencyKey=${task.idempotencyKey}`,
      );
      return { allowed: true };
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
