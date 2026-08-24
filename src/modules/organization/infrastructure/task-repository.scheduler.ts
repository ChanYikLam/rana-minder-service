/**
 * JobSchedulerPort → platform/tasks TaskRepository 桥接（#68 / ADR-004）。
 *
 * 把组织域调度语义（relation_execute / appointment_due / reconcile /
 * deadline_pause）落到平台持久任务仓储：enqueue→insert（intentId 幂等）、
 * acquireLease→tryClaim（单执行租约，CAS-WR-011）、complete/fail→
 * updateAfterExecution、listDue→listDueTaskIds。
 *
 * 租约版本：平台仓储以 lease.leaseVersion 乐观推进；本桥每次先读当前记录取
 * 版本再认领/收口（组织域调用方不感知租约版本）。
 */

import type { JobSchedulerPort, ScheduledTask, ScheduledTaskKind } from '../application/ports';
import type { TaskIntent, TaskRecord, TaskRepository } from '../../../platform/tasks/contracts';
import { TaskScopeKind, type TaskScope } from '../../../platform/tasks/contracts';
import { TaskStatus } from '../../../platform/tasks/contracts';
import { TaskType } from '../../../platform/tasks/contracts';

const KIND_TO_TYPE: Readonly<Record<ScheduledTaskKind, TaskType>> = {
  relation_execute: TaskType.CASDOOR_GROUP_WRITE,
  appointment_due: TaskType.DEADLINE,
  reconcile: TaskType.RECONCILIATION,
  deadline_pause: TaskType.DEADLINE,
};

const LEASE_MS = 60_000;
/** immediate 任务的 notBefore 下限（epoch）：任何时刻都视为到期，且可被 Date 解析 */
const IMMEDIATE_NOT_BEFORE = '1970-01-01T00:00:00.000Z';

export class TaskRepositoryJobScheduler implements JobSchedulerPort {
  constructor(private readonly tasks: TaskRepository) {}

  async enqueue(task: ScheduledTask): Promise<void> {
    const existing = await this.tasks.findByIntentId(task.taskId);
    if (existing !== null) return; // 调度幂等（与内存桩一致）
    const scope = this.scopeOf(task);
    const intent: TaskIntent = {
      intentId: task.taskId,
      taskType: KIND_TO_TYPE[task.kind],
      idempotencyKey: task.idempotencyKey,
      scope,
      source: { objectType: 'org-scheduled-task', objectId: task.refId, version: 1, scope },
      payload: { refId: task.refId, kind: task.kind, scheduleAt: task.at },
      notBefore: task.at ?? IMMEDIATE_NOT_BEFORE,
      createdAt: new Date().toISOString(),
    };
    await this.tasks.insert(intent);
  }

  async acquireLease(taskId: string, holder: string, now: Date): Promise<boolean> {
    // 平台仓储 taskId 为派生追踪号（task:<TYPE>:<intentId>）；组织域以 intentId 寻址
    const record = await this.tasks.findByIntentId(taskId);
    if (record === null) return false;
    if (Date.parse(record.notBefore) > now.getTime()) return false;
    const claimed = await this.tasks.tryClaim(
      record.taskId,
      holder,
      new Date(now.getTime() + LEASE_MS).toISOString(),
      record.lease?.leaseVersion ?? 0,
      now,
    );
    return claimed.claimed;
  }

  async complete(taskId: string): Promise<void> {
    const record = await this.requireRecord(taskId);
    await this.tasks.updateAfterExecution(record.taskId, record.lease?.leaseVersion ?? 0, {
      status: TaskStatus.COMPLETED,
      resultRef: taskId,
      updatedAt: new Date().toISOString(),
    });
  }

  async fail(taskId: string, error: string): Promise<void> {
    const record = await this.requireRecord(taskId);
    // 释放租约并置可重试失败：与内存桩"fail 仅释放持有人"语义对齐，
    // 平台侧退避/重试上限由 retry-policy 与 pipeline 承接
    await this.tasks.updateAfterExecution(record.taskId, record.lease?.leaseVersion ?? 0, {
      status: TaskStatus.RETRYABLE_FAILED,
      lease: null,
      failure: {
        kind: 'EXTERNAL_FAILED',
        reason: error,
        occurredAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    });
  }

  async listDue(now: Date): Promise<ScheduledTask[]> {
    const ids = await this.tasks.listDueTaskIds(now.toISOString(), 100);
    // 并行按 id 取记录，消除 N+1 串行 DB 往返（上限 100 并发查询，
    // 由调用方调度频率与平台仓储池共同约束）。
    const records = await Promise.all(ids.map((id) => this.tasks.findById(id)));
    const out: ScheduledTask[] = [];
    for (const record of records) {
      if (record === null) continue;
      out.push(this.toScheduled(record));
    }
    return out;
  }

  private scopeOf(task: ScheduledTask): TaskScope {
    const clubMatch = /^club:(.+)$/.exec(task.refId);
    if (clubMatch !== null) {
      return { kind: TaskScopeKind.CLUB, clubId: clubMatch[1] };
    }
    return { kind: TaskScopeKind.PLATFORM };
  }

  private toScheduled(record: TaskRecord): ScheduledTask {
    const payload = record.payload as {
      refId?: string;
      kind?: ScheduledTaskKind;
      scheduleAt?: string | null;
    } | null;
    return {
      // 组织域以 intentId 寻址：acquireLease/complete/fail 均走 findByIntentId。
      // 若返回派生的 record.taskId（task:<TYPE>:<intentId>）会与寻址口径不一致，
      // 导致 listDue 产出的任务无法被正确收口（本修复点）。
      taskId: record.intentId,
      kind: payload?.kind ?? 'reconcile',
      refId: payload?.refId ?? record.source.objectId,
      scheduleType: payload?.scheduleAt == null ? 'immediate' : 'at',
      at: payload?.scheduleAt ?? null,
      idempotencyKey: record.idempotencyKey,
      leaseHolder: record.lease?.workerId ?? null,
    };
  }

  private async requireRecord(taskId: string): Promise<TaskRecord> {
    const record = await this.tasks.findByIntentId(taskId);
    if (record === null) {
      throw new Error(`scheduled task not found: ${taskId}`);
    }
    return record;
  }
}
