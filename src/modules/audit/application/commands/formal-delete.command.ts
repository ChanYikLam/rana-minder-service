import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  DeletionScopeKind,
  DeletionStepKind,
  DeletionStepStatus,
} from '../../domain/models/deletion';
import type { DeletionChecklist, DeletionScope, DeletionStep } from '../../domain/models/deletion';
import { AuditEventType, AuditOutcome } from '../../domain/models/audit-event';
import { AuditWriter } from './audit-writer';
import { DeletionPolicy, DeletionPolicyError } from '../../domain/services/deletion-policy';
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
  /** 审计上下文（发起删除的超管敏感操作留痕；AUD-006/008） */
  readonly audit: {
    readonly requestId: string;
    readonly source: { channel: 'WEB' | 'ADMIN' | 'SYSTEM_TASK' | 'BATCH' };
  };
}

/**
 * 正式删除排队（FormalDeleteCommand；AUD-005、AUD-008、AUD-009、IFC-TX-007）。
 *
 * - **仅超管** + 必填原因 + 展示受影响对象清单 + **二次确认**；
 * - 用户仍有成员关系/有效邀请/进行中活动时**须先结束业务关系**（拒绝删除）；
 * - **不建设匿名化**：拒绝变相匿名化用途（完整删除不属于匿名化）；
 * - 生成**独立删除执行清单**（在线库/附件存储/缓存/搜索索引/未过期导出），
 *   保存后由执行器逐项核验；恢复后重放清单防复现；
 * - 发起正式删除（超管敏感操作）**本身落审计留痕**（SUPER_ADMIN_OP，AUD-006/008），
 *   与执行清单时的删除审计共同构成完整留痕链；
 * - 不自动删 Casdoor 账号/Group/Claims，不能召回已发邮件（AUD-006/008）。
 */
@Injectable()
export class FormalDeleteCommand {
  constructor(
    @Inject(DELETION_CHECKLIST_REPOSITORY) private readonly repo: DeletionChecklistRepository,
    private readonly policy: DeletionPolicy,
    private readonly auditWriter: AuditWriter,
  ) {}

  async execute(input: FormalDeleteInput): Promise<DeletionChecklist> {
    this.policy.assertSuperAdmin(input.initiator.roles);
    this.policy.assertReason(input.reason);
    this.policy.assertPurposeAllowed(input.purpose);
    this.policy.assertConfirmed(input.confirmed);
    this.policy.assertBusinessRelationsEnded(input.activeRelations);
    this.assertScopeComplete(input.scope);
    if (input.affectedObjects.length === 0) {
      throw new DeletionPolicyError('IFC-ERR-005', '受影响对象清单不能为空');
    }

    // 各存储类型生成专属定位引用（生产各存储定位符规则不同；I1）
    const baseRef = this.scopeRef(input.scope);
    const steps: readonly DeletionStep[] = (
      [
        [DeletionStepKind.ONLINE_DB, `db:${baseRef}`],
        [DeletionStepKind.ATTACHMENT_STORE, `storage:${baseRef}`],
        [DeletionStepKind.CACHE, `cache:${baseRef}`],
        [DeletionStepKind.SEARCH_INDEX, `index:${baseRef}`],
        [DeletionStepKind.UNEXPIRED_EXPORT, `export:${baseRef}`],
      ] as const
    ).map(([kind, targetRef]) => ({
      stepId: randomUUID(),
      kind,
      targetRef,
      status: DeletionStepStatus.PENDING,
      retryCount: 0,
    }));

    const checklist: DeletionChecklist = {
      checklistId: randomUUID(),
      scope: input.scope,
      reason: input.reason,
      purpose: input.purpose,
      initiatedBy: input.initiator.principalId,
      initiatedAt: new Date().toISOString(),
      confirmed: input.confirmed,
      affectedObjects: input.affectedObjects,
      businessRelationsEnded: true,
      steps,
      completed: false,
      replayCount: 0,
      retryCount: 0,
      needsManualReview: false,
      version: 1,
      auditCommitted: false,
    };
    // **先写审计成功，再落清单**（warning 评审意见）：审计失败则清单不落库，
    // 杜绝"无审计留痕的孤儿清单"（发起删除事件脱敏，仅记录范围与用途）；
    // 发起审计带 checklistPersisted=false 标志（建议级评审意见）：save 成功后补写
    // persisted=true 对账审计——对账规则：仅发起审计而无落库审计 = save 失败孤儿审计
    await this.auditWriter.write({
      eventType: AuditEventType.SUPER_ADMIN_OP,
      actorId: input.initiator.principalId,
      actorRoles: ['SUPER_ADMIN'],
      scope: null,
      source: input.audit.source,
      target: { objectType: 'DELETION_REQUEST', objectId: checklist.checklistId },
      oldValues: null,
      newValues: {
        deletionKind: input.scope.kind,
        purpose: input.purpose,
        checklistPersisted: false,
      },
      outcome: AuditOutcome.SUCCESS,
      requestId: input.audit.requestId,
    });
    await this.repo.save(checklist);
    // 清单已落库 → 补写对账审计（孤儿审计可被对账任务识别并收敛）
    await this.auditWriter.write({
      eventType: AuditEventType.SUPER_ADMIN_OP,
      actorId: input.initiator.principalId,
      actorRoles: ['SUPER_ADMIN'],
      scope: null,
      source: input.audit.source,
      target: { objectType: 'DELETION_CHECKLIST', objectId: checklist.checklistId },
      oldValues: null,
      newValues: { checklistPersisted: true },
      outcome: AuditOutcome.SUCCESS,
      requestId: input.audit.requestId,
    });
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
      default:
        // 前置 assertScopeComplete 已拒绝未知 kind（防御）
        throw new DeletionPolicyError('IFC-ERR-005', '未知删除范围');
    }
  }

  /** scope 完整性校验（各删除范围必填定位字段；IFC-ERR-005） */
  private assertScopeComplete(scope: DeletionScope): void {
    switch (scope.kind) {
      case DeletionScopeKind.SINGLE_RECORD:
        if (
          scope.objectType == null ||
          scope.objectType.trim().length === 0 ||
          scope.objectId == null ||
          scope.objectId.trim().length === 0
        ) {
          throw new DeletionPolicyError('IFC-ERR-005', '单条记录删除需提供 objectType 与 objectId');
        }
        return;
      case DeletionScopeKind.ACTIVITY:
        if (scope.activityId == null || scope.activityId.trim().length === 0) {
          throw new DeletionPolicyError('IFC-ERR-005', '活动范围删除需提供 activityId');
        }
        return;
      case DeletionScopeKind.USER_ALL_DATA:
        if (scope.principalId == null || scope.principalId.trim().length === 0) {
          throw new DeletionPolicyError('IFC-ERR-005', '用户全部数据删除需提供 principalId');
        }
        return;
      default:
        // 未知删除范围 kind：前置防御拒绝（评审意见：补 default，防未知 kind 静默通过
        // 到 scopeRef 生成阶段才报错）
        throw new DeletionPolicyError('IFC-ERR-005', '未知删除范围');
    }
  }
}
