import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  DeletionScopeKind,
  DeletionStepKind,
  DeletionStepStatus,
} from '../../domain/models/deletion';
import type { DeletionChecklist, DeletionScope, DeletionStep } from '../../domain/models/deletion';
import { DeletionPolicy } from '../../domain/services/deletion-policy';
import { DELETION_CHECKLIST_REPOSITORY } from '../../infrastructure/deletion-checklist-repository';
import type { DeletionChecklistRepository } from '../../infrastructure/deletion-checklist-repository';

/** 正式删除输入（AUD-005~010；IFC-TX-007） */
export interface FormalDeleteInput {
  readonly initiator: { principalId: string; roles: readonly string[] };
  readonly scope: DeletionScope;
  /** 必填原因（AUD-005） */
  readonly reason: string;
  /** 用途说明（不建设匿名化校验：拒绝变相匿名化，AUD-010） */
  readonly purpose: string;
  /** 二次确认（展示受影响对象清单后确认；AUD-005/009） */
  readonly confirmed: boolean;
  /** 受影响对象清单（展示/预览） */
  readonly affectedObjects: readonly string[];
  /** 活动业务关系（成员关系/有效邀请/进行中活动；须先结束，AUD-008） */
  readonly activeRelations: readonly { kind: string; ref: string }[];
}

/**
 * 正式删除排队（FormalDeleteCommand；AUD-005、AUD-008、AUD-009、IFC-TX-007）。
 *
 * - **仅超管** + 必填原因 + 展示受影响对象清单 + **二次确认**；
 * - 用户仍有成员关系/有效邀请/进行中活动时**须先结束业务关系**（拒绝删除）；
 * - **不建设匿名化**：拒绝变相匿名化用途（完整删除不属于匿名化）；
 * - 生成**独立删除执行清单**（在线库/附件存储/缓存/搜索索引/未过期导出），
 *   保存后由执行器逐项核验；恢复后重放清单防复现；
 * - 不自动删 Casdoor 账号/Group/Claims，不能召回已发邮件（AUD-006/008）。
 */
@Injectable()
export class FormalDeleteCommand {
  constructor(
    @Inject(DELETION_CHECKLIST_REPOSITORY) private readonly repo: DeletionChecklistRepository,
    private readonly policy: DeletionPolicy,
  ) {}

  async execute(input: FormalDeleteInput): Promise<DeletionChecklist> {
    this.policy.assertSuperAdmin(input.initiator.roles);
    this.policy.assertReason(input.reason);
    this.policy.assertNotAnonymization(input.purpose);
    this.policy.assertConfirmed(input.confirmed);
    this.policy.assertBusinessRelationsEnded(input.activeRelations);
    this.assertScopeComplete(input.scope);
    if (input.affectedObjects.length === 0) {
      throw new Error('IFC-ERR-005: 受影响对象清单不能为空');
    }

    const steps: readonly DeletionStep[] = (
      [
        DeletionStepKind.ONLINE_DB,
        DeletionStepKind.ATTACHMENT_STORE,
        DeletionStepKind.CACHE,
        DeletionStepKind.SEARCH_INDEX,
        DeletionStepKind.UNEXPIRED_EXPORT,
      ] as const
    ).map((kind) => ({
      stepId: randomUUID(),
      kind,
      targetRef: this.scopeRef(input.scope),
      status: DeletionStepStatus.PENDING,
    }));

    const checklist: DeletionChecklist = {
      checklistId: randomUUID(),
      scope: input.scope,
      reason: input.reason,
      initiatedBy: input.initiator.principalId,
      initiatedAt: new Date().toISOString(),
      confirmed: true,
      affectedObjects: input.affectedObjects,
      businessRelationsEnded: true,
      steps,
      completed: false,
      replayCount: 0,
    };
    await this.repo.save(checklist);
    return checklist;
  }

  private scopeRef(scope: DeletionScope): string {
    switch (scope.kind) {
      case DeletionScopeKind.SINGLE_RECORD:
        return `${scope.objectType}:${scope.objectId}`;
      case DeletionScopeKind.ACTIVITY:
        return `activity:${scope.activityId}`;
      case DeletionScopeKind.USER_ALL_DATA:
        return `user:${scope.principalId}`;
    }
  }

  /** scope 完整性校验（各删除范围必填定位字段；IFC-ERR-005） */
  private assertScopeComplete(scope: DeletionScope): void {
    switch (scope.kind) {
      case DeletionScopeKind.SINGLE_RECORD:
        if (
          scope.objectType === undefined ||
          scope.objectType.trim().length === 0 ||
          scope.objectId === undefined ||
          scope.objectId.trim().length === 0
        ) {
          throw new Error('IFC-ERR-005: 单条记录删除需提供 objectType 与 objectId');
        }
        return;
      case DeletionScopeKind.ACTIVITY:
        if (scope.activityId === undefined || scope.activityId.trim().length === 0) {
          throw new Error('IFC-ERR-005: 活动范围删除需提供 activityId');
        }
        return;
      case DeletionScopeKind.USER_ALL_DATA:
        if (scope.principalId === undefined || scope.principalId.trim().length === 0) {
          throw new Error('IFC-ERR-005: 用户全部数据删除需提供 principalId');
        }
        return;
    }
  }
}
