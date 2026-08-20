import { Injectable, Logger } from '@nestjs/common';
import type { TaskOpsTelemetryPort, TaskRepository } from '../contracts';
import { TaskOpsEventType } from '../contracts';
import type { TaskIntentOutbox } from '../outbox';
import type { TaskExecutionPipeline } from '../executors/task-execution-pipeline';

@Injectable()
export class TaskScheduler {
  private readonly logger = new Logger(TaskScheduler.name);

  constructor(
    private readonly repository: TaskRepository,
    private readonly outbox: TaskIntentOutbox,
    private readonly pipeline: TaskExecutionPipeline,
    private readonly ops: TaskOpsTelemetryPort,
  ) {}

  async runOnce(workerId: string, now: Date, limit = 50): Promise<void> {
    const nowIso = now.toISOString();

    await this.outbox.forwardPending(limit, async (intent) => {
      await this.repository.insert(intent);
    });

    const dueIds = await this.repository.listDueTaskIds(nowIso, limit);
    for (const taskId of dueIds) {
      try {
        await this.pipeline.execute(taskId, workerId, now);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await this.ops.report({
          event: TaskOpsEventType.TASK_EXECUTION_FAILED,
          ref: taskId,
          reason,
          occurredAt: nowIso,
        });
      }
    }

    const expiredLeaseIds = await this.repository.listExpiredLeaseTaskIds(nowIso, limit);
    if (expiredLeaseIds.length > 0) {
      await this.ops.report({
        event: TaskOpsEventType.TASK_LEASE_RECOVERED,
        ref: expiredLeaseIds.join(','),
        reason: `发现 ${expiredLeaseIds.length} 个租约过期任务，等待恢复重放`,
        occurredAt: nowIso,
      });
      for (const taskId of expiredLeaseIds) {
        try {
          await this.pipeline.execute(taskId, workerId, now);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          await this.ops.report({
            event: TaskOpsEventType.TASK_EXECUTION_FAILED,
            ref: taskId,
            reason,
            occurredAt: nowIso,
          });
        }
      }
    }

    const summary = await this.repository.backlogSummary();
    const backlog =
      summary.pending + summary.retryableFailed + summary.uncertain + summary.manualIntervention;
    if (backlog > 0) {
      await this.ops.report({
        event: TaskOpsEventType.TASK_BACKLOG,
        ref: 'tasks',
        reason: `pending=${summary.pending}, retryableFailed=${summary.retryableFailed}, uncertain=${summary.uncertain}, manualIntervention=${summary.manualIntervention}`,
        occurredAt: nowIso,
      });
    }
  }
}
