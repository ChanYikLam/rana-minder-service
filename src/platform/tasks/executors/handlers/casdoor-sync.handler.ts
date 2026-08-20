import { Injectable, Logger } from '@nestjs/common';
import type { TaskHandler, TaskRecord } from '../../contracts';
import { TaskType } from '../../contracts';

@Injectable()
export class CasdoorSyncHandler implements TaskHandler {
  readonly taskType = TaskType.CASDOOR_SYNC;
  private readonly logger = new Logger(CasdoorSyncHandler.name);

  async handle(task: TaskRecord): Promise<void> {
    this.logger.log(
      `CasdoorSyncHandler 待接入 identity 模块应用命令：taskId=${task.taskId}, intentId=${task.intentId}`,
    );
  }
}
