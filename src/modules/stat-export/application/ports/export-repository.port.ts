/**
 * 导出任务仓储端口（5.4.2，SRS-SM-EXP-001 持久化边界）。
 *
 * 任务 + 快照同事务落库（IFC-TX-001）：save 为带乐观并发（expectedRevision）的
 * 原子写；外部正式删除/停用失效通过快照匹配查询未过期任务做联动失效（AUD-009/JNT-023）。
 */

import type { ExportTaskAggregate } from '../../domain/models/export-task';

export interface ExportScopeSnapshotMatch {
  readonly clubId?: string;
  readonly departmentId?: string;
  readonly jointActivityId?: string;
  readonly personalTargetUserId?: string;
}

/** listUnexpiredByMatch 的匹配选项 */
export interface ListExportMatchOptions {
  /**
   * 是否纳入终态（EXPIRED/REVOKED）任务。
   *
   * 默认 false：仅返回未过期、非终态的任务（供紧急停用等"只失权活动链接"场景）。
   * 正式删除（applyFormalDelete，AUD-009）须把已过期/已失权但仍保留导出文件的任务也
   * 纳入联动清理，因为状态机允许 EXPIRED/REVOKED --formal_delete_hit--> PRE_DELETED；
   * 否则已过期文件永远不会被正式删除清理，与"不得因导出快照绕过正式删除"不符。
   * 两种场景均不纳入 PRE_DELETED（已删除，无需再联动）。
   */
  readonly includeTerminal?: boolean;
}

export interface ExportTaskRepository {
  /** 幂等保存；expectedRevision 不匹配 → 抛版本冲突（IFC-ERR-008） */
  save(aggregate: ExportTaskAggregate, opts?: { expectedRevision?: number }): Promise<void>;
  load(id: string): Promise<ExportTaskAggregate | null>;
  listByOwner(userId: string): Promise<readonly ExportTaskAggregate[]>;
  /** 未过期、非删除终态、命中快照匹配条件的任务（供失效联动使用；includeTerminal 见上） */
  listUnexpiredByMatch(
    match: ExportScopeSnapshotMatch,
    opts?: ListExportMatchOptions,
  ): Promise<readonly ExportTaskAggregate[]>;
  /**
   * 到期扫描（5.4.4，EXP-003 有效期收敛）：status = DOWNLOADABLE 且
   * expiresAt !== null 且 expiresAt <= nowIso 的任务（供过期清理命令使用）。
   * 仅扫可下载任务：待生成/生成中的任务无文件可清理，其失权由失效联动负责。
   */
  listDueForExpiry(nowIso: string): Promise<readonly ExportTaskAggregate[]>;

  /**
   * 生成租约已过期的卡死任务（status=GENERATING 且 lease.until<=nowIso，评审⑧）。
   * 供过期扫描回收为 FAILED（可重试）：worker 崩溃/被杀后遗留任务不再永久卡死。
   */
  listExpiredLeaseGenerating(nowIso: string): Promise<readonly ExportTaskAggregate[]>;
}

export const EXPORT_TASK_REPOSITORY = Symbol('EXPORT_TASK_REPOSITORY');
