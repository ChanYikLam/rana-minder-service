import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TaskFailure, TaskHandler, TaskRecord } from '../../contracts';
import { TaskExecutionError, TaskType } from '../../contracts';
import { CasdoorWriteService } from '../../../casdoor/application/casdoor-write.service';
import type { WriteConclusionKind } from '../../../casdoor/contracts/types';

interface CasdoorGroupPayload {
  readonly commandId?: string;
  readonly idempotencyKey?: string;
  readonly groupRef?: { owner: string; name: string };
  readonly originalMemberIds?: readonly string[];
  readonly targetMemberIds?: readonly string[];
  readonly requestedAt?: string;
}

function failureKindForConclusion(kind: WriteConclusionKind): TaskFailure['kind'] {
  switch (kind) {
    case 'THIRD_VALUE':
    case 'MANUAL_INTERVENTION_REQUIRED':
      return 'MANUAL_INTERVENTION_REQUIRED';
    case 'UNCERTAIN':
    case 'OLD_VALUE_STILL_PRESENT':
    case 'PARTIAL_SUCCESS':
    case 'DEPENDENCY_UNAVAILABLE':
      // 依赖不可用属可重试的外部故障（外部状态不确定），归类为 EXTERNAL_UNCERTAIN
      // 而非确定性的 EXTERNAL_FAILED，与结论的 retryable=true 语义一致。
      return 'EXTERNAL_UNCERTAIN';
    default:
      return 'EXTERNAL_FAILED';
  }
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
      // payload 不完整属上层意图缺陷，重试无法修复：直接人工处置，避免静默标记成功。
      throw new TaskExecutionError(
        `CasdoorGroupHandler payload 不完整，需人工核验：taskId=${task.taskId}`,
        false,
        'MANUAL_INTERVENTION_REQUIRED',
      );
    }
    const conclusion = await this.casdoorWrite.writeGroupMembership({
      commandId: payload.commandId,
      idempotencyKey: payload.idempotencyKey,
      groupRef: payload.groupRef,
      originalMemberIds: payload.originalMemberIds,
      targetMemberIds: payload.targetMemberIds,
      requestedAt: payload.requestedAt ?? new Date().toISOString(),
    });
    if (conclusion.kind !== 'CONFIRMED') {
      // 非 CONFIRMED 结论（重试型 OLD_VALUE_STILL_PRESENT/PARTIAL_SUCCESS/UNCERTAIN/
      // DEPENDENCY_UNAVAILABLE 或人工核验型 THIRD_VALUE/MANUAL_INTERVENTION_REQUIRED）
      // 必须透传给任务层，按结论 retryable 决定重试或人工介入。
      throw new TaskExecutionError(
        `CasdoorGroupHandler 写入未确认：taskId=${task.taskId}, kind=${conclusion.kind}（${conclusion.reason}）`,
        conclusion.retryable,
        failureKindForConclusion(conclusion.kind),
      );
    }
    this.logger.log(
      `CasdoorGroupHandler 写入已确认：taskId=${task.taskId}, kind=${conclusion.kind}`,
    );
  }
}
