import { Injectable, Logger } from '@nestjs/common';
import type { TaskHandler, TaskRecord } from '../../contracts';
import { TaskType } from '../../contracts';

@Injectable()
export class FormalDeleteHandler implements TaskHandler {
  readonly taskType = TaskType.FORMAL_DELETE;
  private readonly logger = new Logger(FormalDeleteHandler.name);

  async handle(task: TaskRecord): Promise<void> {
    this.logger.log(`FormalDeleteHandler 待接入 audit 模块删除执行命令：taskId=${task.taskId}`);
  }
}
