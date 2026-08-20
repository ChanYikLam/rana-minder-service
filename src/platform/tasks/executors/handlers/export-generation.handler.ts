import { Injectable, Logger } from '@nestjs/common';
import type { TaskHandler, TaskRecord } from '../../contracts';
import { TaskType } from '../../contracts';

@Injectable()
export class ExportGenerationHandler implements TaskHandler {
  readonly taskType = TaskType.EXPORT_GENERATION;
  private readonly logger = new Logger(ExportGenerationHandler.name);

  async handle(task: TaskRecord): Promise<void> {
    this.logger.log(
      `ExportGenerationHandler 待接入 stat-export 模块生成命令：taskId=${task.taskId}`,
    );
  }
}
