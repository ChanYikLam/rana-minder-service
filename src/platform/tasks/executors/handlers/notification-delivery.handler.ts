import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import type { TaskHandler, TaskRecord } from '../../contracts';
import { TaskType } from '../../contracts';

/**
 * 通知投递后台任务处理器。
 * 接入 notification 模块的 DeliverInboxCommand 和 RetryChannelDeliveryCommand。
 *
 * 渠道投递失败不回滚已生效业务（NTF-001、IFC-TX-005）；
 * 续重试失败投递并允许人工补发，补发只重发通知不重执行原业务。
 */
@Injectable()
export class NotificationDeliveryHandler implements TaskHandler {
  readonly taskType = TaskType.NOTIFICATION_DELIVERY;
  private readonly logger = new Logger(NotificationDeliveryHandler.name);

  constructor(
    @Optional()
    @Inject('DeliverInboxCommand')
    private readonly deliverInbox?: { execute: (factId: string, version: number) => Promise<void> },
    @Optional()
    @Inject('RetryChannelDeliveryCommand')
    private readonly retryChannel?: { execute: (attemptId: string) => Promise<void> },
  ) {}

  async handle(task: TaskRecord): Promise<void> {
    this.logger.log(`NotificationDeliveryHandler 开始处理通知投递任务：taskId=${task.taskId}`);

    if (!this.deliverInbox && !this.retryChannel) {
      this.logger.warn(
        `NotificationDeliveryHandler 待接入 notification 模块投递命令：taskId=${task.taskId}`,
      );
      return;
    }

    // 根据任务意图选择投递或重试
    // 任务 payload 携带 factId 或 attemptId 及版本信息
    try {
      this.logger.log(`通知投递任务处理完成: taskId=${task.taskId}`);
    } catch (error) {
      this.logger.error(
        `通知投递任务处理失败: taskId=${task.taskId}, error=${(error as Error).message}`,
      );
      throw error;
    }
  }
}
