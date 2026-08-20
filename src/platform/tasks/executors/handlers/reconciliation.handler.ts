import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TaskHandler, TaskRecord } from '../../contracts';
import { TaskType } from '../../contracts';
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
    const run = await this.reconcile.runFullReconciliation({
      runId: payload.runId ?? `task:${task.taskId}`,
      scope: payload.scope ?? 'platform',
      watermark: payload.watermark ?? task.updatedAt,
      limit: payload.limit ?? 100,
    });
    this.logger.log(
      `ReconciliationHandler 完成对账：taskId=${task.taskId}, runId=${run.runId}, status=${run.status}, pages=${run.pageCount}`,
    );
  }
}
