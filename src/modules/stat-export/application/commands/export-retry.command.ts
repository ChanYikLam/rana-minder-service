/**
 * 导出重试命令（5.4.2，P3，SRS-SM-EXP-001 转换 5）。
 *
 * 失败重试：沿用原快照（范围不变）；变更范围须新申请（EXP-003）。
 * 并发/版本：expectedRevision 与任务当前版本不一致 → IFC-ERR-008；
 * 非失败状态重试 → IFC-ERR-007 状态冲突。
 * 重试前重验：操作者当前仍具备该任务作用域权限（失权即拒绝）。
 */

import { Inject } from '@nestjs/common';

import {
  EXPORT_AUDIT_PORT,
  EXPORT_REAUTH_PORT,
  EXPORT_SAFETY_SWITCH_PORT,
  type ExportAuditPort,
  type ExportPrincipal,
  type ExportReauthPort,
  type ExportSafetySwitchPort,
} from '../ports/export-authorization.port';
import { EXPORT_TASK_REPOSITORY, type ExportTaskRepository } from '../ports/export-repository.port';
import { EXPORT_FACT_SOURCE, type ExportFactSourcePort } from '../ports/export-fact-source.port';
import { ExportTaskStatus } from '../../domain/state-machines/export-task.state-machine';
import {
  assertFreshReauth,
  assertNotSuspended,
  revalidateExportScopeWithFacts,
} from '../export-authorization.policy';
import { exportErrors, ExportError } from '../errors';
import { deniedAuditEntry } from '../export-denied-audit';

export interface ExportRetryInput {
  readonly principal: ExportPrincipal;
  readonly exportId: string;
  readonly expectedRevision: number;
  /** 超管特权导出重试的重新认证凭证时间戳（IFC-ERR-002；可缺省） */
  readonly reauthProofAt?: string;
  readonly now?: Date;
}

export class ExportRetryCommand {
  constructor(
    @Inject(EXPORT_SAFETY_SWITCH_PORT) private readonly safety: ExportSafetySwitchPort,
    @Inject(EXPORT_AUDIT_PORT) private readonly audit: ExportAuditPort,
    @Inject(EXPORT_TASK_REPOSITORY) private readonly repo: ExportTaskRepository,
    @Inject(EXPORT_FACT_SOURCE) private readonly facts: ExportFactSourcePort,
    @Inject(EXPORT_REAUTH_PORT) private readonly reauth: ExportReauthPort,
  ) {}

  async execute(input: ExportRetryInput): Promise<void> {
    const now = input.now ?? new Date();
    try {
      await this.doExecute(input);
    } catch (err) {
      if (err instanceof ExportError) {
        // 拒绝路径审计：越权尝试（IFC-ERR-003）、停用封锁（IFC-ERR-006）、
        // 版本冲突（IFC-ERR-008）、状态冲突（IFC-ERR-007）等安全相关拒绝须留痕可追踪。
        // 任务快照通常已加载，复用其作用域上下文丰富审计；任务不可见（IFC-ERR-015）
        // 时仅记主键亦可定位。
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
            'export_retry',
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

  private async doExecute(input: ExportRetryInput): Promise<void> {
    const now = input.now ?? new Date();

    const safetyState = await this.safety.checkAllowed();
    if (!safetyState.allowed) {
      throw exportErrors.safety('导出安全开关已关闭，拒绝重试（GOV-004）');
    }

    const task = await this.repo.load(input.exportId);
    if (task === null) {
      throw exportErrors.notVisible('导出任务不存在（IFC-ERR-015）');
    }

    if (task.status !== ExportTaskStatus.FAILED) {
      throw exportErrors.stateConflict(`仅失败任务可重试，当前状态 ${task.status}（IFC-ERR-007）`);
    }

    // 重试须由任务申请方发起且仍具备该作用域权限（范围不变才可沿用原快照）
    if (task.requestedByUserId !== input.principal.userId) {
      throw exportErrors.forbidden('仅申请方本人可重试该导出（EXP-003）');
    }
    // 重验操作者当前仍具备该任务作用域权限（含个人副本被代申请目标用户归属回源，
    // 目标成员已离部后原部门负责人不得再重试其副本，EXP-003）。
    await revalidateExportScopeWithFacts(input.principal, task.snapshot.data, this.facts);
    // 停用封锁复核（JNT-023）：重试仅复核作用域权限仍可能绕过封锁——
    // 社团被强制停用/参与社团紧急停用后，停用前失败的任务若可重试会重新生成，
    // 从而绕过封锁。故在重试前与申请同口径复核社团停用状态，封锁则拒绝。
    // 抽公共 assertNotSuspended：与下载控制器共用，保证口径统一。
    await assertNotSuspended(task.snapshot.data, this.facts);

    // 超管特权导出重试（沿用原快照重新生成特权数据）：与申请同口径复核重新认证新鲜度
    // （IFC-ERR-002）。若重认证已过期仍放行，特权导出重试会在重认证失效后被重新生成，
    // 造成特权数据审计/对账缺口（与 apply 侧一致）。
    if (input.principal.kind === 'platform_super_admin') {
      await assertFreshReauth(this.reauth, input.principal.userId, input.reauthProofAt, now);
    }

    // 版本竞争：并发写者先改写则拒绝
    if (input.expectedRevision !== task.revisionNumber) {
      throw exportErrors.versionConflict(
        `导出任务版本不一致（期望 ${input.expectedRevision}，实际 ${task.revisionNumber}），请刷新后重试（IFC-ERR-008）`,
      );
    }

    task.retry(now);
    await this.repo.save(task, { expectedRevision: input.expectedRevision });

    await this.audit.record({
      at: now.toISOString(),
      action: 'export_retry',
      principalId: input.principal.userId,
      // 特权审计须按操作者分类动态标记（STAT-002）：超管特权导出重试同样属特权行为，
      // 硬编码 false 会导致特权导出重试在审计日志丢失特权标记，无法对账。
      privileged: input.principal.kind === 'platform_super_admin',
      clubId: task.snapshot.data.scope.clubId,
      jointActivityId: task.snapshot.data.scope.jointActivityId,
      datasetType: null,
      exportId: task.id,
      purpose: null,
      outcome: 'allowed',
    });
  }
}
