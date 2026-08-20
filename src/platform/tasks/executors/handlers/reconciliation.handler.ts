import { Injectable, Logger } from '@nestjs/common';
import type { TaskHandler, TaskRecord } from '../../contracts';
import { TaskType } from '../../contracts';

@Injectable()
export class ReconciliationHandler implements TaskHandler {
  readonly taskType = TaskType.RECONCILIATION;
  private readonly logger = new Logger(ReconciliationHandler.name);

  async handle(task: TaskRecord): Promise<void> {
    this.logger.log(
      `ReconciliationHandler 待接入 identity/organization 对账命令：taskId=${task.taskId}`,
    );
  }
}
