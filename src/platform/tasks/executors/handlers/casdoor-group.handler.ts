import { Injectable, Logger } from '@nestjs/common';
import type { TaskHandler, TaskRecord } from '../../contracts';
import { TaskType } from '../../contracts';

@Injectable()
export class CasdoorGroupHandler implements TaskHandler {
  readonly taskType = TaskType.CASDOOR_GROUP_WRITE;
  private readonly logger = new Logger(CasdoorGroupHandler.name);

  async handle(task: TaskRecord): Promise<void> {
    this.logger.log(
      `CasdoorGroupHandler 待接入 organization/invitation/membership 应用命令：taskId=${task.taskId}`,
    );
  }
}
