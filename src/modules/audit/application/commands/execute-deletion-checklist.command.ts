import { Inject, Injectable } from '@nestjs/common';
import { AuditEventType, AuditOutcome } from '../../domain/models/audit-event';
import { DeletionStepStatus } from '../../domain/models/deletion';
import type { DeletionChecklist, MinimalDeletionAudit } from '../../domain/models/deletion';
import { AuditWriter } from './audit-writer';
import { DeletionPolicyError } from '../../domain/services/deletion-policy';
import { DELETION_CHECKLIST_REPOSITORY } from '../../infrastructure/deletion-checklist-repository';
import type { DeletionChecklistRepository } from '../../infrastructure/deletion-checklist-repository';

/** 删除步骤执行器注入令牌（DeletionStepExecutorPort 为接口，注入须用显式 token） */
export const DELETION_STEP_EXECUTOR = Symbol('DELETION_STEP_EXECUTOR');

/** 删除步骤执行器端口（跨存储：在线库/附件/缓存/索引/导出；生产接各存储适配） */
export interface DeletionStepExecutorPort {
  /** 删除并回读核验（不伪装原子事务；AUD-009/IFC-TX-007） */
  deleteAndVerify(kind: string, targetRef: string): Promise<{ ok: boolean }>;
}

/** 占位实现（开发期直接确认；生产接存储执行器） */
@Injectable()
export class DefaultDeletionStepExecutor implements DeletionStepExecutorPort {
  async deleteAndVerify(_kind: string, _targetRef: string): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

/** 执行删除清单输入 */
export interface ExecuteDeletionInput {
  readonly checklistId: string;
  /** 恢复后重放（备份恢复防复现；AUD-009） */
  readonly replay?: boolean;
  /** 审计上下文（最小审计落库；W2） */
  readonly audit: {
    readonly requestId: string;
    readonly source: { channel: 'WEB' | 'ADMIN' | 'SYSTEM_TASK' | 'BATCH' };
  };
}

/** 执行结果 */
export interface ExecuteDeletionResult {
  readonly checklist: DeletionChecklist;
  /** 全部核验删除 → 完成；部分失败保持未完成（不宣称完成） */
  readonly completed: boolean;
  /** 删除最小审计（已落库；仅内部标识/时间/超管/类型，不含正文，AUD-006/008） */
  readonly minimalAudit: MinimalDeletionAudit | null;
}

/**
 * 删除清单逐项执行与核验（AUD-009、IFC-TX-007）。
 *
 * - 逐项删除并**回读核验**；**任一步失败保持未完成**，不宣称完成，持续重试；
 * - **并发防护（乐观锁）**：执行后以版本 CAS 提交，同一清单并发执行只一个
 *   提交成功（其余 IFC-ERR-016 冲突拒绝，防重复删除）；
 * - 全部确认删除 → 完成，并**经 AuditWriter 落库删除最小审计**（不保留姓名/
 *   报名内容/评价/附件正文；不自动删 Casdoor、不能召回已发邮件）；
 * - 恢复后重放：清单 replayCount 递增，重新应用防复现。
 */
@Injectable()
export class ExecuteDeletionChecklistCommand {
  constructor(
    @Inject(DELETION_CHECKLIST_REPOSITORY) private readonly repo: DeletionChecklistRepository,
    @Inject(DELETION_STEP_EXECUTOR) private readonly executor: DeletionStepExecutorPort,
    private readonly auditWriter: AuditWriter,
  ) {}

  async execute(input: ExecuteDeletionInput): Promise<ExecuteDeletionResult> {
    const checklist = await this.repo.load(input.checklistId);
    if (checklist === null) {
      throw new DeletionPolicyError('IFC-ERR-015', '删除清单不存在');
    }
    // 幂等：非重放且已完成 → 返回原结果
    if (checklist.completed && input.replay !== true) {
      return { checklist, completed: true, minimalAudit: null };
    }

    let failed = 0;
    let verified = 0;
    // 备份恢复后重放（replay=true）：**即使清单已完成也重新执行全部步骤**，
    // 防止恢复的备份使已删数据复现（AUD-009）
    const steps = await Promise.all(
      checklist.steps.map(async (step) => {
        if (step.status === DeletionStepStatus.VERIFIED_DELETED && input.replay !== true) {
          verified++;
          return step;
        }
        const result = await this.executor.deleteAndVerify(step.kind, step.targetRef);
        if (!result.ok) {
          failed++;
          return { ...step, status: DeletionStepStatus.FAILED };
        }
        verified++;
        return { ...step, status: DeletionStepStatus.VERIFIED_DELETED };
      }),
    );

    const completed =
      failed === 0 && verified === checklist.steps.length && checklist.steps.length > 0;

    const updated: DeletionChecklist = {
      ...checklist,
      steps,
      completed,
      replayCount: input.replay === true ? checklist.replayCount + 1 : checklist.replayCount,
      version: checklist.version + 1,
    };
    // 乐观锁提交：并发执行（同一清单）只一个成功（W1）；**先提交成功再落审计**，
    // 失败方在 CAS 处抛 IFC-ERR-016，不遗留误导性审计（评审意见）
    const committed = await this.repo.compareAndSwap(checklist, updated);
    if (!committed) {
      throw new DeletionPolicyError(
        'IFC-ERR-016',
        '删除清单已被并发执行修改，本次执行作废，请重试',
      );
    }

    // 最小审计（仅内部标识/时间/超管/类型；不含敏感正文，AUD-006/008）
    const minimalAudit: MinimalDeletionAudit | null = completed
      ? {
          internalRecordId: checklist.checklistId,
          deletedAt: new Date().toISOString(),
          performedBy: checklist.initiatedBy,
          deletionType: checklist.scope.kind,
          note: 'minimal-audit-only',
        }
      : null;
    // 仅对**真正提交成功的执行**落审计（CAS 已成功）：成功 → SUCCESS 最小审计；
    // 部分失败 → FAILURE 尝试审计（AUD-009 保留尝试审计，失败详情脱敏）
    if (minimalAudit !== null) {
      await this.auditWriter.write({
        eventType: AuditEventType.SUPER_ADMIN_OP,
        actorId: checklist.initiatedBy,
        actorRoles: ['SUPER_ADMIN'],
        scope: null,
        source: input.audit.source,
        target: { objectType: 'DELETION_CHECKLIST', objectId: checklist.checklistId },
        oldValues: null,
        newValues: { deletionType: minimalAudit.deletionType },
        outcome: AuditOutcome.SUCCESS,
        requestId: input.audit.requestId,
      });
    } else if (failed > 0 || checklist.steps.length === 0) {
      // 部分失败或空清单（理论防御）：保留尝试审计（AUD-009），失败详情脱敏
      await this.auditWriter.write({
        eventType: AuditEventType.SUPER_ADMIN_OP,
        actorId: checklist.initiatedBy,
        actorRoles: ['SUPER_ADMIN'],
        scope: null,
        source: input.audit.source,
        target: { objectType: 'DELETION_CHECKLIST', objectId: checklist.checklistId },
        oldValues: null,
        newValues: { deletionType: checklist.scope.kind, failedSteps: failed },
        outcome: AuditOutcome.FAILURE,
        failureReason: 'deletion-steps-not-verified',
        requestId: input.audit.requestId,
      });
    }
    return { checklist: updated, completed, minimalAudit };
  }
}
