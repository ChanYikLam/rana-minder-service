import { Injectable, Logger } from '@nestjs/common';
import type { TaskHandler, TaskRecord } from '../../contracts';
import { TaskType } from '../../contracts';

@Injectable()
export class DeadlineTaskHandler implements TaskHandler {
  readonly taskType = TaskType.DEADLINE;
  private readonly logger = new Logger(DeadlineTaskHandler.name);

  async handle(task: TaskRecord): Promise<void> {
    this.logger.log(
      `DeadlineTaskHandler 待接入领域截止命令：taskId=${task.taskId}, source=${task.source.objectType}:${task.source.objectId}@${task.source.version}`,
    );
  }
}
