import { Injectable, Logger } from '@nestjs/common';
import type { TaskHandler, TaskRecord } from '../../contracts';
import { TaskType } from '../../contracts';
import { DeliverInboxCommand } from '../../../../modules/notification/application/commands/deliver-inbox.command';
import { RetryChannelDeliveryCommand } from '../../../../modules/notification/application/commands/retry-channel-delivery.command';

/**
 * 通知投递后台任务处理器。
 * 接入 notification 模块的 DeliverInboxCommand 和 RetryChannelDeliveryCommand
 * （类 Token 注入，由 TasksModule 引入 NotificationModule 提供）。
 *
 * 渠道投递失败不回滚已生效业务（NTF-001、IFC-TX-005）；
 * 持续重试失败投递并允许人工补发，补发只重发通知不重执行原业务。
 *
 * 投递/重试命令失败时向上抛出，由任务管道进入失败重试/人工介入，
 * 不静默吞掉（IFC-ERR-008 版本冲突等必须可见可重试）。
 */
@Injectable()
export class NotificationDeliveryHandler implements TaskHandler {
  readonly taskType = TaskType.NOTIFICATION_DELIVERY;
  private readonly logger = new Logger(NotificationDeliveryHandler.name);

  constructor(
    private readonly deliverInbox: DeliverInboxCommand,
    private readonly retryChannel: RetryChannelDeliveryCommand,
  ) {}

  async handle(task: TaskRecord): Promise<void> {
    this.logger.log(`NotificationDeliveryHandler 开始处理通知投递任务：taskId=${task.taskId}`);

    // 根据任务意图选择投递或重试
    // 任务 payload 携带 factId 或 attemptId 及版本信息
    const payload = task.payload as
      | { intent: 'deliver_inbox'; factId: string; expectedVersion: number }
      | { intent: 'retry_channel'; attemptId: string }
      | undefined;

    if (payload?.intent === 'deliver_inbox') {
      const result = await this.deliverInbox.execute(payload.factId, payload.expectedVersion);
      this.logger.log(
        `通知投递任务处理完成: taskId=${task.taskId}, 站内信呈现=${result.presentationCount} 条`,
      );
    } else if (payload?.intent === 'retry_channel') {
      await this.retryChannel.execute(payload.attemptId);
      this.logger.log(
        `通知重试任务处理完成: taskId=${task.taskId}, attemptId=${payload.attemptId}`,
      );
    } else {
      this.logger.warn(
        `NotificationDeliveryHandler 未知任务意图: taskId=${task.taskId}, payload=${JSON.stringify(payload)}`,
      );
    }
  }
}
