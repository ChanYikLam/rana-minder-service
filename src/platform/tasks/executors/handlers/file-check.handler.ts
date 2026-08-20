import { Injectable, Logger } from '@nestjs/common';
import type { TaskHandler, TaskRecord } from '../../contracts';
import { TaskType } from '../../contracts';

@Injectable()
export class FileCheckHandler implements TaskHandler {
  readonly taskType = TaskType.FILE_CHECK;
  private readonly logger = new Logger(FileCheckHandler.name);

  async handle(task: TaskRecord): Promise<void> {
    this.logger.log(`FileCheckHandler 待接入 file 模块检查/预览命令：taskId=${task.taskId}`);
  }
}
