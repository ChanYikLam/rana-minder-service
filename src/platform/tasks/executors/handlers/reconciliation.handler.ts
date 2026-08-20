import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TaskHandler, TaskRecord } from '../../contracts';
import { TaskExecutionError, TaskType } from '../../contracts';
import { CasdoorReconcileService } from '../../../casdoor/application/casdoor-reconcile.service';

interface ReconciliationPayload {
  readonly runId?: string;
  readonly scope?: string;
  readonly watermark?: string;
  readonly limit?: number;
}

@Injectable()
export class ReconciliationHandler implements TaskHandler {
  readonly taskType = TaskType.RECONCILIATION;
  private readonly logger = new Logger(ReconciliationHandler.name);

  constructor(
    @Inject(CasdoorReconcileService)
    private readonly reconcile: CasdoorReconcileService,
  ) {}

  async handle(task: TaskRecord): Promise<void> {
    const payload = (task.payload ?? {}) as ReconciliationPayload;
    // 钳制分页大小到 [1, 1000]，避免负数/极大 limit 引发非法分页或单页过量扫描。
    const rawLimit = payload.limit ?? 100;
    const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? rawLimit : 100, 1000));
    const run = await this.reconcile.runFullReconciliation({
      runId: payload.runId ?? `task:${task.taskId}`,
      scope: payload.scope ?? 'platform',
      watermark: payload.watermark ?? task.updatedAt,
      limit,
    });
    if (run.status !== 'COMPLETE_SUCCESS') {
      // FAILED/UNCERTAIN 可重试；PARTIAL_SUCCESS 表示发现差异候选，需人工核验处置，
      // 不得静默标记任务成功。
      const retryable = run.status === 'FAILED' || run.status === 'UNCERTAIN';
      throw new TaskExecutionError(
        `ReconciliationHandler 对账未完整成功：taskId=${task.taskId}, runId=${run.runId}, status=${run.status}`,
        retryable,
        retryable ? 'EXTERNAL_UNCERTAIN' : 'MANUAL_INTERVENTION_REQUIRED',
      );
    }
    this.logger.log(
      `ReconciliationHandler 完成对账：taskId=${task.taskId}, runId=${run.runId}, status=${run.status}, pages=${run.pageCount}`,
    );
  }
}