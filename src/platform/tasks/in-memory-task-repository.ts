import { Injectable, Logger } from '@nestjs/common';
import { deriveTrackingNumber } from './contracts/task-intent';
import { TaskStatus, isTerminalTaskStatus } from './contracts/task-status';
import type { TaskIntent } from './contracts/task-intent';
import type { TaskRecord, TaskRecordPatch } from './contracts/task-record';
import type { TaskBacklogSummary, TaskClaimResult, TaskRepository } from './contracts/task-ports';
import { TaskType } from './contracts/task-type';

@Injectable()
export class InMemoryTaskRepository implements TaskRepository {
  private readonly logger = new Logger(InMemoryTaskRepository.name);
  private readonly tasks = new Map<string, TaskRecord>();

  async insert(intent: TaskIntent): Promise<TaskRecord> {
    const existing = await this.findByIntentId(intent.intentId);
    if (existing !== null) return existing;

    const task: TaskRecord = {
      taskId: deriveTrackingNumber(intent.intentId, intent.taskType),
      taskType: intent.taskType,
      status: TaskStatus.PENDING,
      intentId: intent.intentId,
      idempotencyKey: intent.idempotencyKey,
      scope: intent.scope,
      source: intent.source,
      payload: intent.payload,
      lease: null,
      attempts: 0,
      maxAttempts: 5,
      notBefore: intent.notBefore,
      failure: null,
      resultRef: null,
      createdAt: intent.createdAt,
      updatedAt: intent.createdAt,
    };
    this.tasks.set(task.taskId, task);
    return task;
  }

  async findById(taskId: string): Promise<TaskRecord | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async findByIntentId(intentId: string): Promise<TaskRecord | null> {
    for (const task of this.tasks.values()) {
      if (task.intentId === intentId) return task;
    }
    return null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<TaskRecord | null> {
    for (const task of this.tasks.values()) {
      if (task.idempotencyKey === idempotencyKey) return task;
    }
    return null;
  }

  async tryClaim(
    taskId: string,
    workerId: string,
    leaseUntil: string,
    leaseVersion: number,
  ): Promise<TaskClaimResult> {
    const current = this.tasks.get(taskId);
    if (current === undefined) return { claimed: false, task: null, reason: 'NOT_FOUND' };
    if (
      current.status === TaskStatus.COMPLETED ||
      current.status === TaskStatus.MANUAL_INTERVENTION
    ) {
      return { claimed: false, task: current, reason: 'TERMINAL' };
    }
    if (current.lease !== null && new Date(current.lease.leaseUntil).getTime() > Date.now()) {
      return { claimed: false, task: current, reason: 'LEASE_BUSY' };
    }

    const claimed: TaskRecord = {
      ...current,
      status: TaskStatus.LEASED,
      lease: {
        workerId,
        leaseVersion,
        leaseUntil,
        leasedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, claimed);
    return { claimed: true, task: claimed };
  }

  async updateAfterExecution(
    taskId: string,
    expectedLeaseVersion: number,
    patch: TaskRecordPatch,
  ): Promise<TaskRecord | null> {
    const current = this.tasks.get(taskId);
    if (current === undefined) return null;
    // 终态写保护：已完成等终态任务不允许再被改写，避免并发/过期执行器覆盖业务结果
    if (isTerminalTaskStatus(current.status)) {
      this.logger.warn(`终态任务拒绝改写：taskId=${taskId}, status=${current.status}`);
      return null;
    }
    if (current.lease !== null && current.lease.leaseVersion !== expectedLeaseVersion) {
      return null;
    }
    const updated: TaskRecord = {
      ...current,
      ...patch,
      lease: patch.lease === undefined ? current.lease : patch.lease,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    this.tasks.set(taskId, updated);
    return updated;
  }

  async listDueTaskIds(now: string, limit: number): Promise<readonly string[]> {
    const nowMs = new Date(now).getTime();
    const ids: string[] = [];
    for (const task of this.tasks.values()) {
      if (ids.length >= limit) break;
      if (
        (task.status === TaskStatus.PENDING || task.status === TaskStatus.RETRYABLE_FAILED) &&
        new Date(task.notBefore).getTime() <= nowMs
      ) {
        ids.push(task.taskId);
      }
    }
    return ids;
  }

  async listDeadlineTaskIds(before: string, limit: number): Promise<readonly string[]> {
    const beforeMs = new Date(before).getTime();
    const ids: string[] = [];
    for (const task of this.tasks.values()) {
      if (ids.length >= limit) break;
      if (task.taskType === TaskType.DEADLINE && new Date(task.notBefore).getTime() <= beforeMs) {
        ids.push(task.taskId);
      }
    }
    return ids;
  }

  async listExpiredLeaseTaskIds(now: string, limit: number): Promise<readonly string[]> {
    const nowMs = new Date(now).getTime();
    const ids: string[] = [];
    for (const task of this.tasks.values()) {
      if (ids.length >= limit) break;
      if (
        task.status === TaskStatus.LEASED &&
        task.lease !== null &&
        new Date(task.lease.leaseUntil).getTime() <= nowMs
      ) {
        ids.push(task.taskId);
      }
    }
    return ids;
  }

  async backlogSummary(): Promise<TaskBacklogSummary> {
    const perType: Record<TaskType, number> = Object.fromEntries(
      Object.values(TaskType).map((type) => [type, 0]),
    ) as Record<TaskType, number>;
    const summary = {
      pending: 0,
      leased: 0,
      retryableFailed: 0,
      uncertain: 0,
      manualIntervention: 0,
      completed: 0,
      perType,
    };
    for (const task of this.tasks.values()) {
      switch (task.status) {
        case TaskStatus.PENDING:
          summary.pending += 1;
          break;
        case TaskStatus.LEASED:
          summary.leased += 1;
          break;
        case TaskStatus.RETRYABLE_FAILED:
          summary.retryableFailed += 1;
          break;
        case TaskStatus.UNCERTAIN:
          summary.uncertain += 1;
          break;
        case TaskStatus.MANUAL_INTERVENTION:
          summary.manualIntervention += 1;
          break;
        case TaskStatus.COMPLETED:
          summary.completed += 1;
          break;
      }
      summary.perType[task.taskType] += 1;
    }
    return summary;
  }
}
