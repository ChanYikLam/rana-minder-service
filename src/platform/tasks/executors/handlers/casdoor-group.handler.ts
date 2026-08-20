import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TaskHandler, TaskRecord } from '../../contracts';
import { TaskType } from '../../contracts';
import { CasdoorWriteService } from '../../../casdoor/application/casdoor-write.service';

interface CasdoorGroupPayload {
  readonly commandId?: string;
  readonly idempotencyKey?: string;
  readonly groupRef?: { owner: string; name: string };
  readonly originalMemberIds?: readonly string[];
  readonly targetMemberIds?: readonly string[];
  readonly requestedAt?: string;
}

@Injectable()
export class CasdoorGroupHandler implements TaskHandler {
  readonly taskType = TaskType.CASDOOR_GROUP_WRITE;
  private readonly logger = new Logger(CasdoorGroupHandler.name);

  constructor(
    @Inject(CasdoorWriteService)
    private readonly casdoorWrite: CasdoorWriteService,
  ) {}

  async handle(task: TaskRecord): Promise<void> {
    const payload = (task.payload ?? {}) as CasdoorGroupPayload;
    if (
      !payload.commandId ||
      !payload.idempotencyKey ||
      !payload.groupRef ||
      !payload.originalMemberIds ||
      !payload.targetMemberIds
    ) {
      this.logger.log(
        `CasdoorGroupHandler 已接入统一适配写服务，等待 organization/invitation/membership 应用命令：taskId=${task.taskId}`,
      );
      return;
    }
    const conclusion = await this.casdoorWrite.writeGroupMembership({
      commandId: payload.commandId,
      idempotencyKey: payload.idempotencyKey,
      groupRef: payload.groupRef,
      originalMemberIds: payload.originalMemberIds,
      targetMemberIds: payload.targetMemberIds,
      requestedAt: payload.requestedAt ?? new Date().toISOString(),
    });
    this.logger.log(`CasdoorGroupHandler 写入结论：taskId=${task.taskId}, kind=${conclusion.kind}`);
  }
}
