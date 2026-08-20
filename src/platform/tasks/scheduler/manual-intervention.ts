import { Injectable, Logger } from '@nestjs/common';
import { TaskStatus } from '../contracts';
import type { TaskRecord, TaskRepository } from '../contracts';

@Injectable()
export class ManualInterventionService {
  private readonly logger = new Logger(ManualInterventionService.name);

  constructor(private readonly repository: TaskRepository) {}

  async markManualIntervention(
    taskId: string,
    reason: string,
    now: Date,
  ): Promise<TaskRecord | null> {
    const task = await this.repository.findById(taskId);
    if (task === null) return null;
    return this.repository.updateAfterExecution(taskId, task.lease?.leaseVersion ?? 0, {
      status: TaskStatus.MANUAL_INTERVENTION,
      failure: { kind: 'MANUAL_INTERVENTION_REQUIRED', reason, occurredAt: now.toISOString() },
      updatedAt: now.toISOString(),
    });
  }

  async requeue(taskId: string, now: Date): Promise<TaskRecord | null> {
    const task = await this.repository.findById(taskId);
    if (task === null) return null;
    if (task.status !== TaskStatus.MANUAL_INTERVENTION) {
      this.logger.warn(
        `仅 MANUAL_INTERVENTION 状态可人工重试：taskId=${taskId}, status=${task.status}`,
      );
      return task;
    }
    return this.repository.updateAfterExecution(taskId, task.lease?.leaseVersion ?? 0, {
      status: TaskStatus.PENDING,
      lease: null,
      failure: null,
      updatedAt: now.toISOString(),
    });
  }

  async close(taskId: string, reason: string, now: Date): Promise<TaskRecord | null> {
    const task = await this.repository.findById(taskId);
    if (task === null) return null;
    return this.repository.updateAfterExecution(taskId, task.lease?.leaseVersion ?? 0, {
      status: TaskStatus.COMPLETED,
      resultRef: `manual-closed:${reason}`,
      updatedAt: now.toISOString(),
    });
  }
}
