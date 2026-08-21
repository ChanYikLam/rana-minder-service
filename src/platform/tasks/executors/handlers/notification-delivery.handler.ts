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
    private readonly deliverInbox?: {
      execute: (factId: string, version: number) => Promise<{ presentationCount: number }>;
    },
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
    const payload = task.payload as
      | { intent: 'deliver_inbox'; factId: string; expectedVersion: number }
      | { intent: 'retry_channel'; attemptId: string }
      | undefined;

    try {
      if (payload?.intent === 'deliver_inbox' && this.deliverInbox) {
        const result = await this.deliverInbox.execute(payload.factId, payload.expectedVersion);
        this.logger.log(
          `通知投递任务处理完成: taskId=${task.taskId}, 站内信呈现=${result.presentationCount} 条`,
        );
      } else if (payload?.intent === 'retry_channel' && this.retryChannel) {
        await this.retryChannel.execute(payload.attemptId);
        this.logger.log(
          `通知重试任务处理完成: taskId=${task.taskId}, attemptId=${payload.attemptId}`,
        );
      } else {
        this.logger.warn(
          `NotificationDeliveryHandler 未知任务意图或命令未就绪: taskId=${task.taskId}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `通知投递任务处理失败: taskId=${task.taskId}, error=${(error as Error).message}`,
      );
      throw error;
    }
  }
}
