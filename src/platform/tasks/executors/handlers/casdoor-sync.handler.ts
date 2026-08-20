import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TaskHandler, TaskRecord } from '../../contracts';
import { TaskType } from '../../contracts';
import { CasdoorReadService } from '../../../casdoor/application/casdoor-read.service';

interface CasdoorSyncPayload {
  readonly externalUserId?: string;
  readonly localSubjectId?: string;
  readonly trackingId?: string;
}

@Injectable()
export class CasdoorSyncHandler implements TaskHandler {
  readonly taskType = TaskType.CASDOOR_SYNC;
  private readonly logger = new Logger(CasdoorSyncHandler.name);

  constructor(
    @Inject(CasdoorReadService)
    private readonly casdoorRead: CasdoorReadService,
  ) {}

  async handle(task: TaskRecord): Promise<void> {
    const payload = (task.payload ?? {}) as CasdoorSyncPayload;
    if (!payload.externalUserId || !payload.trackingId) {
      this.logger.log(
        `CasdoorSyncHandler 已接入统一适配读服务，等待 identity 应用命令：taskId=${task.taskId}, intentId=${task.intentId}`,
      );
      return;
    }
    const result = await this.casdoorRead.readAccountState({
      externalUserId: payload.externalUserId,
      reason: 'CASDOOR_SYNC_TASK',
      freshness: 'REAL_TIME',
      trackingId: payload.trackingId,
    });
    this.logger.log(
      `CasdoorSyncHandler 读取账号状态完成：taskId=${task.taskId}, status=${result.status}, trackingId=${payload.trackingId}`,
    );
  }
}
