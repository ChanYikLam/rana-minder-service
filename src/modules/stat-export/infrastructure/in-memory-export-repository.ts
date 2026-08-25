/**
 * 内存导出任务仓储（开发/单测桩，5.4.2）。
 *
 * 带乐观并发：save 携带 expectedRevision，与落库版本不一致即抛版本冲突（IFC-ERR-008）。
 * listUnexpiredByMatch 供正式删除（AUD-009）与紧急停用（JNT-023）联动失效使用。
 *
 * 版本冲突抛出 ExportError（TOCTOU 窗口一致性）：
 * 仓储 save 在 expectedRevision 预检与落库之间存在窄 TOCTOU 窗口，被并发写者推进
 * 版本时即应被调用方按 IFC-ERR-008 语义处理（拒绝路径审计、409 状态映射）。使用
 * 领域错误类型而非普通 Error 可确保 execute/byApplicant/catchErrors 的 instanceof
 * ExportError 分支一致命中，避免漏留 denied 审计或被误映射为 500（IFC-ERR-016）。
 */

import { ExportTaskAggregate } from '../domain/models/export-task';
import { ExportTaskStateMachine } from '../domain/state-machines/export-task.state-machine';
import {
  EXPORT_TASK_REPOSITORY,
  type ExportScopeSnapshotMatch,
  type ExportTaskRepository,
  type ListExportMatchOptions,
} from '../application/ports/export-repository.port';
import { ExportTaskStatus } from '../domain/state-machines/export-task.state-machine';
import { ExportError } from '../application/errors';

export class InMemoryExportTaskRepository implements ExportTaskRepository {
  private readonly store = new Map<string, ExportTaskAggregate>();
  private readonly storedRevision = new Map<string, number>();

  save(aggregate: ExportTaskAggregate, opts?: { expectedRevision?: number }): Promise<void> {
    const current = this.storedRevision.get(aggregate.id);
    if (opts?.expectedRevision !== undefined && current !== opts.expectedRevision) {
      return Promise.reject(
        new ExportError(
          'IFC-ERR-008',
          `导出任务版本竞争（期望 ${opts.expectedRevision}，实际 ${current}）`,
        ),
      );
    }
    this.store.set(aggregate.id, aggregate);
    this.storedRevision.set(aggregate.id, aggregate.revisionNumber);
    return Promise.resolve();
  }

  async load(id: string): Promise<ExportTaskAggregate | null> {
    const found = this.store.get(id);
    return found === undefined
      ? null
      : ExportTaskAggregate.fromSnapshot(new ExportTaskStateMachine(), found.toData());
  }

  async listByOwner(userId: string): Promise<readonly ExportTaskAggregate[]> {
    return [...this.store.values()].filter((t) => t.ownerUserId === userId);
  }

  async listUnexpiredByMatch(
    match: ExportScopeSnapshotMatch,
    opts?: ListExportMatchOptions,
  ): Promise<readonly ExportTaskAggregate[]> {
    const includeTerminal = opts?.includeTerminal === true;
    // 返回脱敏拷贝（与 load 一致），避免批量失效循环内 mutate 污染存储中的同一对象，
    // 否则单条版本冲突被跳过时，该任务已因 mutate 而"假失效"。
    const detach = (t: ExportTaskAggregate) =>
      ExportTaskAggregate.fromSnapshot(new ExportTaskStateMachine(), t.toData());
    return [...this.store.values()].map(detach).filter((t) => {
      const scope = t.snapshot.data.scope;
      // 未过期：默认排除删除/失权/过期终态（这些链路已收口，无需再联动）。
      // 正式删除（applyFormalDelete，AUD-009）须 includeTerminal=true 纳入
      // EXPIRED/REVOKED，否则已过期文件永远不会被正式删除清理（状态机允许
      // EXPIRED/REVOKED --formal_delete_hit--> PRE_DELETED）。PRE_DELETED 两种场景
      // 均不纳入（已删除无需再联动）。
      if (t.status === ExportTaskStatus.PRE_DELETED) {
        return false;
      }
      if (
        !includeTerminal &&
        (t.status === ExportTaskStatus.REVOKED || t.status === ExportTaskStatus.EXPIRED)
      ) {
        return false;
      }
      if (match.clubId !== undefined) {
        const clubRelated =
          scope.clubId === match.clubId ||
          (scope.kind === 'joint' && scope.participantClubIds.includes(match.clubId));
        if (!clubRelated) return false;
      }
      if (match.jointActivityId !== undefined && scope.jointActivityId !== match.jointActivityId) {
        return false;
      }
      if (
        match.personalTargetUserId !== undefined &&
        t.snapshot.data.personalTargetUserId !== match.personalTargetUserId
      ) {
        return false;
      }
      return true;
    });
  }

  async listDueForExpiry(nowIso: string): Promise<readonly ExportTaskAggregate[]> {
    // 到期扫描（5.4.4，EXP-003）：仅 DOWNLOADABLE 且已设置有效期且已到期。
    // 时间比较统一用 Date 毫秒值，避免对 ISO 字符串做字典序比较的隐式依赖。
    const nowMs = new Date(nowIso).getTime();
    const detach = (t: ExportTaskAggregate) =>
      ExportTaskAggregate.fromSnapshot(new ExportTaskStateMachine(), t.toData());
    return [...this.store.values()].map(detach).filter((t) => {
      if (t.status !== ExportTaskStatus.DOWNLOADABLE) return false;
      if (t.expiresAt === null) return false;
      return new Date(t.expiresAt).getTime() <= nowMs;
    });
  }

  async listExpiredLeaseGenerating(nowIso: string): Promise<readonly ExportTaskAggregate[]> {
    // 生成租约回收（5.4.4，评审⑧）：GENERATING 且 lease.until<=now（worker 崩溃遗留）。
    const nowMs = new Date(nowIso).getTime();
    const detach = (t: ExportTaskAggregate) =>
      ExportTaskAggregate.fromSnapshot(new ExportTaskStateMachine(), t.toData());
    return [...this.store.values()].map(detach).filter((t) => {
      if (t.status !== ExportTaskStatus.GENERATING) return false;
      const until = t.lease?.until;
      if (until === undefined || until === null) return false;
      return new Date(until).getTime() <= nowMs;
    });
  }
}

export { EXPORT_TASK_REPOSITORY };
