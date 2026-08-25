/**
 * 导出删除与失效命令（5.4.2，P4，SRS-SM-EXP-001 转换 9/10 / AUD-009 / JNT-023）。
 *
 * - byApplicant（转换 9）：申请人提前删除，仅本人/授权者（超级管理员亦可）；
 * - applyFormalDelete（转换 10）：正式删除清单命中导出内容 → 未过期导出失效（AUD-009，
 *   不得因导出快照绕过正式删除）；
 * - invalidateUnexpiredBySuspension（JNT-023）：参与社团被紧急停用后，已有未过期
 *   链接立即失权，使后续不能下载。
 *
 * 5.4.4 补充（AUD-009 并清理）：上述三类失效在状态收敛成功后，对已持有 fileRef
 * 的任务尽力而为删除对象存储文件（EXPORT_DISPOSAL_PORT）——清理失败不阻断失效
 * （状态已不可下载），但必须留 warn 日志；残留文件由过期扫描/正式删除联动兜底。
 */

import { Inject, Logger } from '@nestjs/common';

import {
  EXPORT_AUDIT_PORT,
  EXPORT_SAFETY_SWITCH_PORT,
  type ExportAuditEntry,
  type ExportAuditPort,
  type ExportPrincipal,
  type ExportSafetySwitchPort,
} from '../ports/export-authorization.port';
import { EXPORT_TASK_REPOSITORY, type ExportTaskRepository } from '../ports/export-repository.port';
import { EXPORT_DISPOSAL_PORT, type ExportDisposalPort } from '../ports/export-disposal.port';
import { ExportTaskStatus } from '../../domain/state-machines/export-task.state-machine';
import type { ExportTaskAggregate } from '../../domain/models/export-task';
import { exportErrors, ExportError } from '../errors';
import { deniedAuditEntry } from '../export-denied-audit';

// ---------------------------------------------------------------------------
// 提前删除（申请人本人/授权者）
// ---------------------------------------------------------------------------

export interface ExportDeleteInput {
  readonly principal: ExportPrincipal;
  readonly exportId: string;
  readonly expectedRevision: number;
  readonly now?: Date;
}

export class ExportDeleteCommand {
  private readonly logger = new Logger(ExportDeleteCommand.name);

  constructor(
    @Inject(EXPORT_SAFETY_SWITCH_PORT) private readonly safety: ExportSafetySwitchPort,
    @Inject(EXPORT_AUDIT_PORT) private readonly audit: ExportAuditPort,
    @Inject(EXPORT_TASK_REPOSITORY) private readonly repo: ExportTaskRepository,
    @Inject(EXPORT_DISPOSAL_PORT) private readonly disposal: ExportDisposalPort,
  ) {}

  /** 申请人提前删除（仅本人 / 授权者；超管可代删） */
  async byApplicant(input: ExportDeleteInput): Promise<void> {
    const now = input.now ?? new Date();
    try {
      await this.doByApplicant(input, now);
    } catch (err) {
      if (err instanceof ExportError) {
        // 拒绝路径审计：越权删除（IFC-ERR-003）、状态冲突（IFC-ERR-007）、
        // 版本冲突（IFC-ERR-008）、安全开关关闭（IFC-ERR-011）等拒绝须留痕可追踪。
        // 任务快照可能不可见，尽力复用其作用域上下文丰富审计。
        let clubId: string | null = null;
        let jointActivityId: string | null = null;
        try {
          const t = await this.repo.load(input.exportId);
          if (t !== null) {
            clubId = t.snapshot.data.scope.clubId ?? null;
            jointActivityId =
              t.snapshot.data.scope.kind === 'joint'
                ? (t.snapshot.data.scope.jointActivityId ?? null)
                : null;
          }
        } catch {
          // 审计上下文增强失败不影响原拒绝抛出
        }
        await this.audit.record(
          deniedAuditEntry(
            now.toISOString(),
            'export_delete',
            {
              principal: input.principal,
              clubId,
              jointActivityId,
              datasetType: null,
              exportId: input.exportId,
              purpose: null,
            },
            err,
          ),
        );
      }
      throw err;
    }
  }

  private async doByApplicant(input: ExportDeleteInput, now: Date): Promise<void> {
    const safetyState = await this.safety.checkAllowed();
    if (!safetyState.allowed) {
      throw exportErrors.safety('导出安全开关已关闭，拒绝提前删除（GOV-004）');
    }

    const task = await this.repo.load(input.exportId);
    if (task === null) {
      throw exportErrors.notVisible('导出任务不存在（IFC-ERR-015）');
    }

    this.assertDeleteAuthorized(input.principal, task);

    if (task.status === ExportTaskStatus.PRE_DELETED) {
      throw exportErrors.stateConflict('该导出已提前删除（IFC-ERR-007）');
    }
    // 仅允许来自"待生成/失败/可下载"的执行提前删除；生成中/失权/过期/新建不可
    if (
      task.status !== ExportTaskStatus.PENDING_GENERATION &&
      task.status !== ExportTaskStatus.FAILED &&
      task.status !== ExportTaskStatus.DOWNLOADABLE
    ) {
      throw exportErrors.stateConflict(`当前状态 ${task.status} 不可提前删除（IFC-ERR-007）`);
    }

    if (input.expectedRevision !== task.revisionNumber) {
      throw exportErrors.versionConflict(
        `导出任务版本不一致（期望 ${input.expectedRevision}，实际 ${task.revisionNumber}）（IFC-ERR-008）`,
      );
    }

    task.preDelete(now);
    await this.repo.save(task, { expectedRevision: input.expectedRevision });

    // AUD-009 并清理：提前删除成功后尽力删除对象存储文件（失败不阻断失效）
    await this.disposeBestEffort(task);

    await this.audit.record({
      at: now.toISOString(),
      action: 'export_delete',
      principalId: input.principal.userId,
      privileged: input.principal.kind === 'platform_super_admin',
      clubId: task.snapshot.data.scope.clubId,
      jointActivityId: task.snapshot.data.scope.jointActivityId,
      datasetType: null,
      exportId: task.id,
      purpose: null,
      outcome: 'allowed',
    });
  }

  /**
   * 正式删除清单联动（AUD-009）：查找未过期、非删除、命中删除选择集的任务，
   * 统一转 PRE_DELETED（转换 10）。返回失效任务数。
   *
   * AUD-009 不可绕删：状态机允许 EXPIRED/REVOKED --formal_delete_hit--> PRE_DELETED，
   * 故通过 includeTerminal=true 把已过期/已失权但仍保留导出文件的任务也纳入联动清理，
   * 否则已过期文件永远不会被正式删除清理。
   *
   * 设计取舍（显式声明）：此为"清理/合规删除"系统操作，语义上是撤销对已删除内容的导出
   * 访问，而非新的导出授权。故与 byApplicant（申请方主动删除）不同，不校验导出安全开关
   * （GOV-004）——即使开关关闭，也不得让已删除内容因开关关闭而残留可访问导出链接。
   * 对应地，系统级 audit 的 privileged 恒为 false（非用户特权行为），属预期行为。
   */
  async applyFormalDelete(input: {
    selection: { clubId?: string; jointActivityId?: string };
    principalId?: string;
    now?: Date;
  }): Promise<number> {
    const now = input.now ?? new Date();
    const when = now.toISOString();
    const candidates = await this.repo.listUnexpiredByMatch(
      {
        clubId: input.selection.clubId,
        jointActivityId: input.selection.jointActivityId,
      },
      { includeTerminal: true },
    );
    let count = 0;
    for (const candidate of candidates) {
      // 并发容错：失效逻辑下沉到 invalidateCandidate，命中版本冲突（IFC-ERR-008）
      // 时重读最新聚合后重试一次；二次仍冲突则跳过该条，留待下一轮联动清理。
      const invalidated = await this.invalidateCandidate(
        candidate,
        (t) => t.status !== ExportTaskStatus.PRE_DELETED,
        (t) => t.formalDeleteHit(now),
        // 并发/资格跳过须留痕：避免正式删除联动下"失效遗漏无痕"残留窗口（评审①/④）。
        async (reason) =>
          this.audit.record({
            at: when,
            action: 'export_formal_delete_invalidate',
            principalId: input.principalId ?? 'system',
            privileged: false,
            clubId: candidate.snapshot.data.scope.clubId,
            jointActivityId: candidate.snapshot.data.scope.jointActivityId,
            datasetType: null,
            exportId: candidate.id,
            purpose: null,
            outcome: 'denied',
            reason,
          }),
      );
      if (invalidated === null) continue;
      count += 1;
      // AUD-009 并清理：正式删除命中失效成功后尽力删除对象存储文件
      await this.disposeBestEffort(invalidated);
      await this.recordSystemAudit(
        when,
        'export_formal_delete_invalidate',
        input.principalId ?? 'system',
        invalidated,
      );
    }
    return count;
  }

  /**
   * 参与社团紧急停用（JNT-023）：已有未过期（待生成/生成中/可下载）链接立即失权，
   * 使其不可再下载。返回失效任务数。
   *
   * 设计取舍（显式声明）：此为"失权"系统操作，撤销紧急停用社团的既有导出访问，语义上
   * 是安全收敛而非新的授权。故不校验导出安全开关（GOV-004）——即使开关关闭，也不得让
   * 被紧急停用社团的导出链接继续可访问（否则封锁即被绕过）。对应地，系统级 audit 的
   * privileged 恒为 false，属预期行为。
   */
  async invalidateUnexpiredBySuspension(input: {
    clubId: string;
    principalId?: string;
    now?: Date;
  }): Promise<number> {
    const now = input.now ?? new Date();
    const when = now.toISOString();
    const candidates = await this.repo.listUnexpiredByMatch({ clubId: input.clubId });
    let count = 0;
    for (const candidate of candidates) {
      const invalidated = await this.invalidateCandidate(
        candidate,
        (t) =>
          t.status === ExportTaskStatus.PENDING_GENERATION ||
          t.status === ExportTaskStatus.GENERATING ||
          t.status === ExportTaskStatus.DOWNLOADABLE,
        (t) => t.revoke(`参与社团 ${input.clubId} 紧急停用（JNT-023）`, now),
        // 并发/资格跳过须留痕：参与社团紧急停用（JNT-023）下未过期链接失权若被并发跳过
        // 且无痕，则封锁存在残留可下载窗口（评审①/④）。
        async (reason) =>
          this.audit.record({
            at: when,
            action: 'export_suspension_invalidate',
            principalId: input.principalId ?? 'system',
            privileged: false,
            clubId: candidate.snapshot.data.scope.clubId,
            jointActivityId: candidate.snapshot.data.scope.jointActivityId,
            datasetType: null,
            exportId: candidate.id,
            purpose: null,
            outcome: 'denied',
            reason,
          }),
      );
      if (invalidated === null) continue;
      count += 1;
      // JNT-023 并清理：紧急停用失效成功后尽力删除对象存储文件
      await this.disposeBestEffort(invalidated);
      await this.recordSystemAudit(
        when,
        'export_suspension_invalidate',
        input.principalId ?? 'system',
        invalidated,
      );
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /**
   * 尽力而为删除对象存储文件（5.4.4，AUD-009 并清理）：
   * - 任务未持有 fileRef（待生成/失败态等）→ 无需清理，直接返回；
   * - dispose 失败仅留 warn 日志，不阻断失效链路——状态已收敛为不可下载，
   *   残留文件由过期扫描 / 正式删除联动（includeTerminal 覆盖 EXPIRED/REVOKED）
   *   兜底清理；但"静默残留无痕"不可接受，故必须落日志。
   */
  private async disposeBestEffort(task: ExportTaskAggregate): Promise<void> {
    const fileRef = task.fileRef;
    if (!fileRef) return;
    try {
      await this.disposal.dispose(fileRef);
    } catch (err) {
      this.logger.warn(
        `导出文件删除联动清理失败（exportId=${task.id}, fileRef=${fileRef}，失效已生效不回滚）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** 判断是否为乐观并发版本冲突（IFC-ERR-008），用于批量失效时捕获并跳过单条竞争 */
  private isVersionConflict(err: unknown): boolean {
    return (
      err instanceof Error &&
      ((err as Error & { code?: string }).code === 'IFC-ERR-008' ||
        err.message.includes('IFC-ERR-008'))
    );
  }

  /**
   * 单条候选的失效：乐观保存失败（IFC-ERR-008）时重读最新聚合后重试一次；
   * 二次仍冲突或候选已被并发写者处理完毕/不再符合失效条件则跳过该条，不中断整批。
   *
   * 评审约束（并发/审计留痕）：被跳过的候选必须留痕（审计或日志），否则并发竞争下
   * 会形成"失效遗漏无痕"（AUD-009 不可绕删下存在残留窗口）。故提供 onSkipped 回调，
   * 由调用方在跳过时记录审计/日志，两种跳过场景均会触发。
   *
   * @param initial 已从 list 加载的候选脱敏拷贝
   * @param eligible 重读后的资格复核：返回 false 表示候选已被并发处理或不再符合失效条件
   * @param mutate 在资格通过后执行的失效变更（formalDeleteHit / revoke）
   * @param onSkipped 候选被跳过时的留痕回调（参数为可披露的跳过原因，不含敏感数据）
   * @returns 实际成功失效的聚合（含最新 revisionNumber）；null 表示该条被跳过
   */
  private async invalidateCandidate(
    initial: ExportTaskAggregate,
    eligible: (task: ExportTaskAggregate) => boolean,
    mutate: (task: ExportTaskAggregate) => void,
    onSkipped: (reason: string) => Promise<void> | void,
  ): Promise<ExportTaskAggregate | null> {
    let task: ExportTaskAggregate | null = initial;
    for (let round = 0; round < 2 && task !== null; round += 1) {
      if (!eligible(task)) {
        // 候选已被并发处理或不再符合失效条件（如已被其他写者提前处理/状态已推进）。
        await onSkipped(
          `候选 ${initial.id} 已不再符合失效条件（状态 ${initial.status}），跳过留待后续联动`,
        );
        return null;
      }
      // 记录变更前版本作为乐观并发基线（避免依赖 `revisionNumber - 1` 魔法算术，
      // 与状态机版本递增解耦——transition 后 aggregate.revisionNumber 才会 +1）。
      const expectedRevision = task.revisionNumber;
      mutate(task);
      try {
        await this.repo.save(task, { expectedRevision });
        return task;
      } catch (err) {
        if (!this.isVersionConflict(err)) throw err; // 真实仓储异常不静默吞掉
        task = round === 0 ? await this.repo.load(initial.id) : null;
      }
    }
    // 二次重读后仍版本冲突（IFC-ERR-008）或并发写者已处理完毕，跳过该条。
    await onSkipped(`候选 ${initial.id} 在并发失效下仍版本冲突（IFC-ERR-008），跳过留待后续联动`);
    return null;
  }

  private assertDeleteAuthorized(principal: ExportPrincipal, task: ExportTaskAggregate): void {
    const isOwner = task.ownerUserId === principal.userId;
    const isAuthorizer = task.authorizerUserId === principal.userId;
    const isSuperAdmin = principal.kind === 'platform_super_admin';
    if (!isOwner && !isAuthorizer && !isSuperAdmin) {
      throw exportErrors.forbidden('仅申请人本人或授权者可提前删除该导出（EXP-003）');
    }
  }

  private recordSystemAudit(
    at: string,
    action: ExportAuditEntry['action'],
    principalId: string,
    task: ExportTaskAggregate,
  ): Promise<void> {
    return this.audit.record({
      at,
      action,
      principalId,
      privileged: false,
      clubId: task.snapshot.data.scope.clubId,
      jointActivityId: task.snapshot.data.scope.jointActivityId,
      datasetType: null,
      exportId: task.id,
      purpose: null,
      outcome: 'allowed',
    });
  }
}
