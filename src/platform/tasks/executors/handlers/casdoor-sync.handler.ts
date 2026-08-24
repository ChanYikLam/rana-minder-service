import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TaskHandler, TaskRecord } from '../../contracts';
import { TaskExecutionError, TaskType } from '../../contracts';
import { CasdoorReadService } from '../../../casdoor/application/casdoor-read.service';
import {
  FreshnessRegistry,
  FreshnessLevel,
  OPERATION_PERMISSION_SENSITIVE_READ,
} from '../../../casdoor/domain/freshness-registry';

interface CasdoorSyncPayload {
  readonly externalUserId?: string;
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
      throw new TaskExecutionError(
        `CasdoorSyncHandler payload 不完整，需人工核验：taskId=${task.taskId}`,
        false,
        'MANUAL_INTERVENTION_REQUIRED',
      );
    }
    // 复用登记式新鲜度目录的失败关闭语义（CAS-Q-002）：未知操作按实时读回，
    // 避免 ?? 'REAL_TIME' 形成第二套策略逻辑。
    const requireRealTime = this.freshness.requireRealTime(OPERATION_PERMISSION_SENSITIVE_READ);
    const freshness = requireRealTime ? FreshnessLevel.REAL_TIME : FreshnessLevel.OBSERVATION;
    const result = await this.casdoorRead.readAccountState({
      externalUserId: payload.externalUserId,
      reason: 'CASDOOR_SYNC_TASK',
      freshness,
      trackingId: payload.trackingId,
    });
    if (result.status !== 'TRUSTED_CURRENT') {
      // 读回未确认：依赖不可用/不确定可重试，账号不存在等稳定结论交给人工核验。
      const retryable = result.status === 'DEPENDENCY_UNAVAILABLE' || result.status === 'UNCERTAIN';
      throw new TaskExecutionError(
        `CasdoorSyncHandler 读取账号状态未确认：taskId=${task.taskId}, status=${result.status}`,
        retryable,
        retryable ? 'EXTERNAL_UNCERTAIN' : 'EXTERNAL_FAILED',
      );
    }
    this.logger.log(
      `CasdoorSyncHandler 读取账号状态完成：taskId=${task.taskId}, status=${result.status}, trackingId=${payload.trackingId}`,
    );
  }
}
