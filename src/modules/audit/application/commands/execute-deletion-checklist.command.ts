import { Inject, Injectable } from '@nestjs/common';
import { AuditEventType, AuditOutcome } from '../../domain/models/audit-event';
import {
  DeletionStepStatus,
  MAX_STEP_RETRY_COUNT,
  MAX_REPLAY_COUNT,
} from '../../domain/models/deletion';
import type { DeletionChecklist, MinimalDeletionAudit } from '../../domain/models/deletion';
import { AuditWriter } from './audit-writer';
import { DeletionPolicyError } from '../../domain/services/deletion-policy';
import { DELETION_CHECKLIST_REPOSITORY } from '../../infrastructure/deletion-checklist-repository';
import type { DeletionChecklistRepository } from '../../infrastructure/deletion-checklist-repository';

/** 删除步骤执行器注入令牌（DeletionStepExecutorPort 为接口，注入须用显式 token） */
export const DELETION_STEP_EXECUTOR = Symbol('DELETION_STEP_EXECUTOR');

/** 删除步骤执行器端口（跨存储：在线库/附件/缓存/索引/导出；生产接各存储适配） */
export interface DeletionStepExecutorPort {
  /**
   * 删除并回读核验（不伪装原子事务；AUD-009/IFC-TX-007）。
   * **必须幂等**：同一 targetRef 重复调用删除结果一致（并发下多个执行可能都实际
   * 删除存储，仅一个 CAS 提交胜出；重复删除无害——info 评审意见显式声明）
   */
  deleteAndVerify(kind: string, targetRef: string): Promise<{ ok: boolean }>;
}

/**
 * 占位实现（开发期占位；生产接存储执行器）。
 *
 * **fail-closed**：未接入真实删除执行器时，直接调用删除并回读核验会抛错，
 * 而非恒返回 `{ok:true}`，避免“假删除/假清理”被静默确认（评审 critical）。
 * 接线分支须在接入真实各存储执行器后再启用命令，否则执行即失败（安全兜底）。
 */
@Injectable()
export class DefaultDeletionStepExecutor implements DeletionStepExecutorPort {
  async deleteAndVerify(_kind: string, _targetRef: string): Promise<{ ok: boolean }> {
    throw new DeletionPolicyError(
      'IFC-ERR-016',
      '删除步骤执行器未接线（占位实现 fail-closed）：请先接入真实各存储删除执行器',
    );
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
    const replay = input.replay === true;
    // 需人工介入（达重试上限）：拒绝自动重试，防无限空转
    if (checklist.needsManualReview && !replay) {
      throw new DeletionPolicyError('IFC-ERR-016', '删除清单已达重试上限，需人工介入');
    }
    // 幂等：已完成且**审计已落**且非重放 → 返回原结果；
    // 已完成但审计缺失（auditCommitted=false，审计写入曾失败）→ 继续执行补审计
    if (checklist.completed && checklist.auditCommitted && !replay) {
      return { checklist, completed: true, minimalAudit: null };
    }
    // 重放已完成+审计已落清单时：步骤须重执行（防复现），但审计不应重复落（去重）
    const replayOfDoneAudited = replay && checklist.completed && checklist.auditCommitted;

    // 恢复重放次数上限（AUD-009 评审）：防备份恢复后无限重放累积，超出由运维介入
    if (replay && checklist.replayCount >= MAX_REPLAY_COUNT) {
      throw new DeletionPolicyError(
        'IFC-ERR-016',
        '删除清单恢复重放次数已达上限，需运维介入评估后再重放',
      );
    }

    let failed = 0;
    let verified = 0;
    // 备份恢复后重放（replay=true）：**即使清单已完成也重新执行全部步骤**，
    // 防止恢复的备份使已删数据复现（AUD-009）
    const steps = await Promise.all(
      checklist.steps.map(async (step) => {
        if (step.status === DeletionStepStatus.VERIFIED_DELETED && !replay) {
          verified++;
          return step;
        }
        const result = await this.executor.deleteAndVerify(step.kind, step.targetRef);
        if (!result.ok) {
          failed++;
          // 失败重试计数递增：防 FAILED 步骤无限重试空转（AUD-009 评审），
          // 超出 MAX_STEP_RETRY_COUNT 后保持未完成并由接线层告警收敛
          return {
            ...step,
            status: DeletionStepStatus.FAILED,
            retryCount: (step.retryCount ?? 0) + 1,
          };
        }
        verified++;
        return { ...step, status: DeletionStepStatus.VERIFIED_DELETED, retryCount: 0 };
      }),
    );

    // 存在超出重试上限的步骤 → 需人工介入（防无限重试，接线层据此告警）。
    // 基于**本次执行后**的 steps 判定（评审意见：不得用执行前的旧 steps，
    // 否则本次成功归零的步骤仍按旧上限计入，重试上限判定滞后一轮）
    const exhaustedRetries = steps.some((s) => (s.retryCount ?? 0) >= MAX_STEP_RETRY_COUNT);

    const completed =
      failed === 0 && verified === checklist.steps.length && checklist.steps.length > 0;

    // 重试上限判定（未完成且非重放）：**必须在首次 CAS 之前**——达上限时直接以
    // 人工介入状态 CAS 提交，避免普通 updated 先落库导致二次 CAS 版本冲突、
    // needsManualReview 无法持久化（warning 评审意见）；步骤级 exhaustedRetries
    // （评审者 81ec386）与清单级 retryCount 任一达上限均触发人工介入
    const retryCount = replay ? checklist.retryCount : checklist.retryCount + 1;
    const exceeded =
      !completed && !replay && (retryCount >= MAX_STEP_RETRY_COUNT || exhaustedRetries);
    if (exceeded) {
      const updatedWithRetry: DeletionChecklist = {
        ...checklist,
        steps,
        completed: false,
        replayCount: checklist.replayCount, // exceeded 分支 replay 恒非 true（TS 控制流）
        retryCount,
        needsManualReview: true,
        version: checklist.version + 1,
        auditCommitted: false,
      };
      const committed = await this.repo.compareAndSwap(checklist, updatedWithRetry);
      if (committed) {
        // 人工介入审计落库（状态不滞留"上限-1"，重试任务不再拉取该清单空转）
        await this.auditWriter.write({
          eventType: AuditEventType.SUPER_ADMIN_OP,
          actorId: checklist.initiatedBy,
          actorRoles: ['SUPER_ADMIN'],
          scope: null,
          source: input.audit.source,
          target: { objectType: 'DELETION_CHECKLIST', objectId: checklist.checklistId },
          oldValues: null,
          newValues: { deletionType: checklist.scope.kind, needsManualReview: true },
          outcome: AuditOutcome.FAILURE,
          failureReason: 'max-step-retry-reached',
          requestId: input.audit.requestId,
        });
      }
      // 已持久化人工介入状态：抛错由接线层告警收敛（评审者语义），
      // 且 needsManualReview 已落库（后续自动重试被拒绝，warning 语义）
      throw new DeletionPolicyError(
        'IFC-ERR-016',
        '删除步骤失败重试已达上限，需人工介入处理后再继续',
      );
    }

    const updated: DeletionChecklist = {
      ...checklist,
      steps,
      completed,
      replayCount: replay ? checklist.replayCount + 1 : checklist.replayCount,
      retryCount,
      needsManualReview: checklist.needsManualReview,
      version: checklist.version + 1,
      // 审计待提交（成功后二次 CAS 置 true；失败则保持 false，普通重试可补写）。
      // 重放已完成+审计已落清单：保留 auditCommitted=true，避免破坏幂等标志（去重）
      auditCommitted: replayOfDoneAudited ? true : false,
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

    // 判定本次是否需要落审计：
    // - 重放已完成+审计已落清单：**不重复落审计**（SUCCESS 审计已在首次完成时记录，去重）
    // - 否则：已完成 → SUCCESS 最小审计；部分失败/空清单 → FAILURE 尝试审计
    //   （AUD-009 保留尝试审计，失败详情脱敏）
    const needsAudit = !replayOfDoneAudited;
    let auditWritten = false;
    if (needsAudit && minimalAudit !== null) {
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
      auditWritten = true;
    } else if (needsAudit && (failed > 0 || checklist.steps.length === 0)) {
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
      auditWritten = true;
    }
    // 审计已落 → 置 auditCommitted=true（二次 CAS）。**检查返回值**：
    // - 成功 → 返回态与持久态一致（auditCommitted=true）
    // - 失败（他方已再次提交）→ 重读最新持久态返回，杜绝返回态与持久态不一致，
    //   也避免普通重试因持久态 auditCommitted=false 而重复执行+重复写审计
    if (auditWritten) {
      const finalized: DeletionChecklist = { ...updated, auditCommitted: true };
      const finalizedOk = await this.repo.compareAndSwap(updated, finalized);
      if (!finalizedOk) {
        const latest = await this.repo.load(input.checklistId);
        return { checklist: latest ?? finalized, completed, minimalAudit };
      }
      return { checklist: finalized, completed, minimalAudit };
    }
    return { checklist: updated, completed, minimalAudit };
  }
}
