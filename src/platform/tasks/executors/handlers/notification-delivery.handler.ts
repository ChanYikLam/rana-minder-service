import { Injectable, Logger } from '@nestjs/common';
import type { TaskHandler, TaskRecord } from '../../contracts';
import { TaskType } from '../../contracts';

@Injectable()
export class NotificationDeliveryHandler implements TaskHandler {
  readonly taskType = TaskType.NOTIFICATION_DELIVERY;
  private readonly logger = new Logger(NotificationDeliveryHandler.name);

  async handle(task: TaskRecord): Promise<void> {
    this.logger.log(
      `NotificationDeliveryHandler 待接入 notification 模块投递命令：taskId=${task.taskId}`,
    );
  }
}
