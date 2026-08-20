import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TaskHandler, TaskRecord } from '../../contracts';
import { TaskType } from '../../contracts';
import { CasdoorReadService } from '../../../casdoor/application/casdoor-read.service';
import {
  FreshnessRegistry,
  OPERATION_PERMISSION_SENSITIVE_READ,
} from '../../../casdoor/domain/freshness-registry';

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
    @Inject(FreshnessRegistry)
    private readonly freshness: FreshnessRegistry,
  ) {}

  async handle(task: TaskRecord): Promise<void> {
    const payload = (task.payload ?? {}) as CasdoorSyncPayload;
    if (!payload.externalUserId || !payload.trackingId) {
      this.logger.log(
        `CasdoorSyncHandler 已接入统一适配读服务，等待 identity 应用命令：taskId=${task.taskId}, intentId=${task.intentId}`,
      );
      return;
    }
    // 由登记式新鲜度目录决定同步任务的读回新鲜度（CAS-Q-002），不再硬编码。
    const freshness =
      this.freshness.resolve(OPERATION_PERMISSION_SENSITIVE_READ)?.level ?? 'REAL_TIME';
    const result = await this.casdoorRead.readAccountState({
      externalUserId: payload.externalUserId,
      reason: 'CASDOOR_SYNC_TASK',
      freshness,
      trackingId: payload.trackingId,
    });
    this.logger.log(
      `CasdoorSyncHandler 读取账号状态完成：taskId=${task.taskId}, status=${result.status}, trackingId=${payload.trackingId}`,
    );
  }
}
