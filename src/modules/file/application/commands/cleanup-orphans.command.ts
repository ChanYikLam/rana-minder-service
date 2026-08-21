import { Inject, Injectable } from '@nestjs/common';
import { FileState, FileStateMachine } from '../../domain/state-machines/file-state-machine';
import type { CleanupQueueItem, FileRecord } from '../../domain/models/file-model';
import { locationKeyOf } from '../../domain/services/object-location';
import { FILE_REPOSITORY } from '../../infrastructure/file-repository';
import type { FileRepository } from '../../infrastructure/file-repository';
import { OBJECT_STORE_PORT } from '../../infrastructure/object-store-port';
import type { ObjectStorePort } from '../../infrastructure/object-store-port';
import { deleteAndVerifyBatch } from './async-batch';
import { CLEANUP_REFERENCE_GUARD } from '../../infrastructure/cleanup-reference-guard-port';
import type { CleanupReferenceGuardPort } from '../../infrastructure/cleanup-reference-guard-port';

/** 孤儿/受控清理前置失败（IFC-ERR-006 前置条件失败） */
export class CleanupOrphansError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-006: ${message}`);
    this.name = 'CleanupOrphansError';
  }
}

/**
 * 孤儿与受控清理任务（FORM-009、AUD-008）。
 *
 * 草稿删除/替换后登记到 cleanupQueue 的对象由系统**稍后安全物理清理**：
 * - 执行前重新检查（本文件已处于待清理；并做**防御性引用复核**，经引用复核端口
 *   确认不再被任何有效访问路径引用的对象才物理删除，避免并发误删仍被引用的原件）；
 * - 逐项删除并**回读核验**；任一失败保持待清理并持续重试，不恢复访问；
 * - 全部确认删除 → 已清理（临时文件终态）；**不得删除审计**。
 */
@Injectable()
export class CleanupOrphansCommand {
  constructor(
    @Inject(FILE_REPOSITORY) private readonly repo: FileRepository,
    @Inject(OBJECT_STORE_PORT) private readonly store: ObjectStorePort,
    @Inject(CLEANUP_REFERENCE_GUARD)
    private readonly referenceGuard: CleanupReferenceGuardPort,
    private readonly stateMachine: FileStateMachine = new FileStateMachine(),
  ) {}

  async execute(fileId: string): Promise<FileRecord> {
    const file = await this.repo.load(fileId);
    if (file === null) {
      throw new CleanupOrphansError('文件不存在');
    }
    if (file.state !== FileState.PENDING_CLEANUP) {
      throw new CleanupOrphansError(`文件不在待清理状态（当前 ${file.state}）`);
    }
    if (file.deletionManifest !== null) {
      throw new CleanupOrphansError('正式删除清单接管，由删除清单处理');
    }

    // 防御性引用复核（IFC-FIL-009：物理删除边界不得误删仍有效的引用）：
    // cleanupQueue 本应只含"替换/删除后失去最后有效引用"的旧对象，但在并发接管或
    // 异常状态下（如清理与替换/绑定/其它文件引用竞争），对象可能仍被其他活跃文件或
    // 有效访问路径引用。删除前逐项经**引用复核端口**确认无有效引用，仍被引用的对象
    // 一律跳过本次物理删除（保持 PENDING 待后续复核），避免并发误删（FORM-009）。
    const protectedKeys = new Set<string>();
    const toDelete: CleanupQueueItem[] = [];
    for (const q of file.cleanupQueue) {
      if (q.status === 'VERIFIED_DELETED') {
        protectedKeys.add(locationKeyOf(q.location)); // 已删终态项保留，不参与本次删除
      } else if (await this.referenceGuard.hasActiveReference(q.location)) {
        protectedKeys.add(locationKeyOf(q.location)); // 仍被有效引用：跳过，待后续复核
      } else {
        toDelete.push(q); // 无有效引用：纳入本次物理删除
      }
    }

    // 有界并发逐项删除+回读核验（避免对对象存储无界突发请求；保持输入顺序）
    const deleted = await deleteAndVerifyBatch(toDelete, 8, (location) =>
      this.store.deleteAndVerify(location),
    );
    // 仍被引用的保留项（保持原状态）+ 本次已删项合并回队列（保留每项最新状态）
    const queue = [
      ...file.cleanupQueue.filter((q) => protectedKeys.has(locationKeyOf(q.location))),
      ...deleted,
    ];

    // 从结果推导，避免在并发回调中修改共享可变状态；任一 FAILED 则保持待清理并持续重试
    const allVerified = queue.every((item) => item.status === 'VERIFIED_DELETED');
    const state = allVerified
      ? this.stateMachine.transition(FileState.PENDING_CLEANUP, FileState.CLEANED)
      : FileState.PENDING_CLEANUP; // 部分失败：保持待清理并持续重试
    const updated: FileRecord = { ...file, state, cleanupQueue: queue };
    await this.repo.save(updated);
    return updated;
  }
}
