import { Injectable, Logger } from '@nestjs/common';
import type { TaskClaimResult, TaskRecord, TaskRecordPatch, TaskRepository } from '../contracts';
import { computeLeaseUntil, decideLease, isLeaseValid } from './lease';

@Injectable()
export class LeaseManager {
  private readonly logger = new Logger(LeaseManager.name);

  constructor(private readonly repository: TaskRepository) {}

  async tryClaim(
    taskId: string,
    workerId: string,
    leaseMs: number,
    now: Date,
  ): Promise<TaskClaimResult> {
    const task = await this.repository.findById(taskId);
    if (task === null) return { claimed: false, task: null, reason: 'NOT_FOUND' };
    const decision = decideLease(task.lease, now);
    if (decision === 'BUSY') return { claimed: false, task, reason: 'LEASE_BUSY' };
    const leaseUntil = computeLeaseUntil(now, leaseMs);
    const leaseVersion = (task.lease?.leaseVersion ?? 0) + 1;
    return this.repository.tryClaim(taskId, workerId, leaseUntil, leaseVersion);
  }

  async listExpiredLeaseTaskIds(now: string, limit: number): Promise<readonly string[]> {
    return this.repository.listExpiredLeaseTaskIds(now, limit);
  }

  async release(task: TaskRecord, patch: TaskRecordPatch): Promise<TaskRecord | null> {
    if (isLeaseValid(task.lease, new Date()) === false) {
      this.logger.warn(`租约已过期，释放被忽略：taskId=${task.taskId}`);
      return task;
    }
    return this.repository.updateAfterExecution(task.taskId, task.lease?.leaseVersion ?? 0, patch);
  }
}
