/**
 * 导出过期清理命令（5.4.4，转换 8，EXP-003 有效期收敛 / AUD-009 文件清理）。
 *
 * 扫描仓储中已到期的可下载任务（status=DOWNLOADABLE 且 expiresAt<=now），
 * 逐条 expire() 收敛状态并尽力删除对象存储文件：
 * - 状态保存做一次版本冲突容忍（IFC-ERR-008）：重读后仍到期未终态则重试一次，
 *   二次冲突/已被并发处理则跳过该条，不中断整批（幂等：重复扫描无副作用）；
 * - dispose 为 best-effort（失败仅告警、计入 disposed 之外，绝不回滚过期状态）。
 *   残留窗口说明：预签名下载短链在真实对象存储下无法即时吊销（与
 *   ports/export-file-access.port.ts 的残留窗口口径一致），但任务状态已收敛为
 *   EXPIRED——后续任何"新下载"均被实时重验拒绝；残留文件由下一轮扫描或正式删除
 *   联动（AUD-009 includeTerminal 已覆盖 EXPIRED）兜底清理。单条存储故障不应阻塞
 *   整批过期收敛，故失败不回滚。
 * - 每条成功过期记录审计 export_expire(allowed)（principalId='system'，系统收敛操作）。
 *
 * 5.4.4 扩展（评审⑧ 租约回收）：同时扫描「生成租约已过期但任务仍停在 GENERATING」
 * 的卡死任务（worker 崩溃/进程被杀后遗留），逐条 markGenerationFailed 置为 FAILED
 * （转换 4，可重试、沿用原快照）——避免任务永久停留在 GENERATING、无任何恢复路径。
 */

import { Inject, Logger } from '@nestjs/common';

import { EXPORT_TASK_REPOSITORY, type ExportTaskRepository } from '../ports/export-repository.port';
import { EXPORT_DISPOSAL_PORT, type ExportDisposalPort } from '../ports/export-disposal.port';
import { EXPORT_AUDIT_PORT, type ExportAuditPort } from '../ports/export-authorization.port';
import { ExportTaskAggregate } from '../../domain/models/export-task';
import { ExportTaskStatus } from '../../domain/state-machines/export-task.state-machine';

export interface ExportExpirySweepResult {
  /** 本轮成功置为 EXPIRED 的任务数 */
  readonly expired: number;
  /** 本轮成功删除对象存储文件的任务数（dispose 失败不计入，也不回滚过期） */
  readonly disposed: number;
  /** 本轮因生成租约过期被回收为 FAILED（可重试）的任务数（评审⑧） */
  readonly recovered: number;
}

export class ExportExpirySweepCommand {
  private readonly logger = new Logger(ExportExpirySweepCommand.name);

  constructor(
    @Inject(EXPORT_TASK_REPOSITORY) private readonly repo: ExportTaskRepository,
    @Inject(EXPORT_DISPOSAL_PORT) private readonly disposal: ExportDisposalPort,
    @Inject(EXPORT_AUDIT_PORT) private readonly audit: ExportAuditPort,
  ) {}

  /**
   * 执行一轮过期扫描。命令本身幂等：重复执行对已过期任务无副作用
   * （扫描任务由运维轮询触发；见 platform/tasks ExportExpiryScanHandler JSDoc）。
   */
  async run(now?: Date): Promise<ExportExpirySweepResult> {
    const at = (now ?? new Date()).toISOString();
    const due = await this.repo.listDueForExpiry(at);

    let expired = 0;
    let disposed = 0;
    for (const candidate of due) {
      const done = await this.expireOne(candidate, at);
      if (done === null) continue;
      expired += 1;
      const doneData = done.toData();
      if (doneData.fileRef !== null && (await this.disposeBestEffort(doneData.fileRef, done.id))) {
        disposed += 1;
      }
      await this.recordExpireAudit(at, done.id, done);
    }

    // 租约过期回收（评审⑧）：GENERATING 且 lease.until<=now → FAILED（可重试）
    const stuck = await this.repo.listExpiredLeaseGenerating(at);
    let recovered = 0;
    for (const candidate of stuck) {
      const done = await this.recoverStaleLease(candidate, at);
      if (done === null) continue;
      recovered += 1;
      await this.recordExpireAudit(at, done.id, done);
    }

    return { expired, disposed, recovered };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private isVersionConflict(err: unknown): boolean {
    return (
      err instanceof Error &&
      ((err as Error & { code?: string }).code === 'IFC-ERR-008' ||
        err.message.includes('IFC-ERR-008'))
    );
  }

  /** 过期审计（best-effort：审计通道故障仅告警，不阻塞状态收敛，评审⑧） */
  private async recordExpireAudit(
    at: string,
    exportId: string,
    task: ExportTaskAggregate,
  ): Promise<void> {
    try {
      await this.audit.record({
        at,
        action: 'export_expire',
        principalId: 'system',
        privileged: false,
        clubId: task.snapshot.data.scope.clubId,
        jointActivityId: task.snapshot.data.scope.jointActivityId,
        datasetType: null,
        exportId,
        purpose: null,
        outcome: 'allowed',
      });
    } catch (err) {
      this.logger.warn(
        `导出过期/租约回收审计记录失败（exportId=${exportId}）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * 单条过期：乐观保存失败时重读最新聚合后重试一次；二次仍冲突或候选已被并发
   * 处理完毕/不再符合条件则跳过该条（返回 null），不中断整批。
   *
   * @returns 过期后的聚合（含最新 revisionNumber）；null 表示该条被跳过
   */
  private async expireOne(
    initial: ExportTaskAggregate,
    at: string,
  ): Promise<ExportTaskAggregate | null> {
    let task: ExportTaskAggregate | null = initial;
    for (let round = 0; round < 2 && task !== null; round += 1) {
      // 资格复核：仅 DOWNLOADABLE 且已设置有效期且确已到期才允许收敛
      const data = task.toData();
      if (
        task.status !== ExportTaskStatus.DOWNLOADABLE ||
        data.expiresAt === null ||
        data.expiresAt > at
      ) {
        return null; // 已被并发处理或不再符合条件
      }
      const expectedRevision = task.revisionNumber;
      task.expire(new Date(at));
      try {
        await this.repo.save(task, { expectedRevision });
        return task;
      } catch (err) {
        if (!this.isVersionConflict(err)) throw err; // 真实仓储异常不静默吞掉
        task = round === 0 ? await this.repo.load(initial.id) : null;
      }
    }
    return null;
  }

  /**
   * 租约过期回收（评审⑧）：GENERATING 且租约已到期 → markGenerationFailed
   * （转换 4 GENERATING→FAILED，可重试、沿用原快照）。乐观保存失败时重读重试
   * 一次；二次冲突/已被并发处理（如原 worker 实际仍在跑并已成功）则跳过。
   *
   * @returns 回收后的聚合；null 表示该条被跳过
   */
  private async recoverStaleLease(
    initial: ExportTaskAggregate,
    at: string,
  ): Promise<ExportTaskAggregate | null> {
    let task: ExportTaskAggregate | null = initial;
    for (let round = 0; round < 2 && task !== null; round += 1) {
      const data = task.toData();
      if (task.status !== ExportTaskStatus.GENERATING || data.lease === null) {
        return null; // 已被并发处理（成功/失权/过期/删除）
      }
      const expectedRevision = task.revisionNumber;
      task.markGenerationFailed('生成租约已过期，系统回收（lease timeout）', new Date(at));
      try {
        await this.repo.save(task, { expectedRevision });
        return task;
      } catch (err) {
        if (!this.isVersionConflict(err)) throw err; // 真实仓储异常不静默吞掉
        task = round === 0 ? await this.repo.load(initial.id) : null;
      }
    }
    return null;
  }

  /**
   * 尽力而为删除对象存储文件（AUD-009 清理）：失败留 warn 日志但不阻断——
   * 过期是状态机收敛（不可再下载），存储残留由下轮扫描/正式删除联动兜底。
   */
  private async disposeBestEffort(fileRef: string, exportId: string): Promise<boolean> {
    try {
      await this.disposal.dispose(fileRef);
      return true;
    } catch (err) {
      this.logger.warn(
        `导出文件过期清理失败（exportId=${exportId}, fileRef=${fileRef}，不回滚过期状态）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }
}
