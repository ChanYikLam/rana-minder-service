/**
 * 资料同步/读回任务处理器（job 模块；IFC-SM-003 消费接力）。
 *
 * 由 job 执行单元领取 job_tasks 后调用；经 identity 的 ApplyProfileSyncStepUseCase
 * 逐次执行一个字段版本的一步（启动写入 → Casdoor 写回 → 定向读回 → 按读回值收口）。
 *
 * 关键约束（ADR-004 §2、CAS-REC-001、API-AUTH-004）：
 * - 后台执行单元使用服务账号身份（独立于普通用户、可审计）；
 * - 业务状态转换在 IdentityUnitOfWork 事务边界内原子收口（本地事实 + 任务意图
 *   同事务，IFC-TX-001/003）；
 * - RETRY_SCHEDULED / READBACK_SCHEDULED 时用例已登记新任务，当前任务完成即可；
 * - 幂等：迟到/过期/被取代任务由用例按目标版本拒绝（IDN-007），重复执行安全。
 */

import type { ApplyProfileSyncStepUseCase } from '../identity/application/commands/apply-profile-sync-step.use-case';
import type { IdentityUnitOfWork } from '../identity/infrastructure/unit-of-work';
import type { ClaimedJobTask } from './job-task.store';
import type { EditableProfileField } from '../identity/domain/models/profile-field';

/** 后台执行单元服务账号（API-AUTH-004：最小权限、独立于普通用户、可审计） */
export const JOB_SERVICE_ACCOUNT = 'svc:profile-sync';

export interface ProfileSyncTaskPayload {
  readonly subjectId: string;
  readonly field: EditableProfileField;
  readonly targetVersion: number;
  readonly intentId: string;
}

export class ProfileSyncTaskHandler {
  constructor(
    private readonly applyStep: ApplyProfileSyncStepUseCase,
    private readonly uow: IdentityUnitOfWork,
  ) {}

  async execute(task: ClaimedJobTask): Promise<void> {
    const payload = task.payload as unknown as ProfileSyncTaskPayload;
    if (
      typeof payload.subjectId !== 'string' ||
      typeof payload.field !== 'string' ||
      typeof payload.targetVersion !== 'number' ||
      typeof payload.intentId !== 'string'
    ) {
      throw new Error('任务载荷格式不正确（缺少 subjectId/field/targetVersion/intentId）');
    }
    await this.uow.run({ kind: 'single', subjectId: payload.subjectId }, async () => {
      await this.applyStep.execute({
        subjectId: payload.subjectId,
        field: payload.field,
        targetVersion: payload.targetVersion,
        intentId: payload.intentId,
        now: new Date(),
        actor: JOB_SERVICE_ACCOUNT,
        traceId: task.id,
      });
    });
  }
}