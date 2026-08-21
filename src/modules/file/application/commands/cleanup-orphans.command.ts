import { Inject, Injectable } from '@nestjs/common';
import { FileState, FileStateMachine } from '../../domain/state-machines/file-state-machine';
import type { FileRecord } from '../../domain/models/file-model';
import { FILE_REPOSITORY } from '../../infrastructure/file-repository';
import type { FileRepository } from '../../infrastructure/file-repository';
import { OBJECT_STORE_PORT } from '../../infrastructure/object-store-port';
import type { ObjectStorePort } from '../../infrastructure/object-store-port';
import { mapWithConcurrency } from './async-batch';

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
 * - 执行前重新检查（本文件已处于待清理且无有效引用——调用方负责引用复核）；
 * - 逐项删除并**回读核验**；任一失败保持待清理并持续重试，不恢复访问；
 * - 全部确认删除 → 已清理（临时文件终态）；**不得删除审计**。
 */
@Injectable()
export class CleanupOrphansCommand {
  constructor(
    @Inject(FILE_REPOSITORY) private readonly repo: FileRepository,
    @Inject(OBJECT_STORE_PORT) private readonly store: ObjectStorePort,
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

    // 有界并发逐项删除+回读核验（避免对对象存储无界突发请求；保持输入顺序）
    const queue = await mapWithConcurrency(file.cleanupQueue, 8, async (item) => {
      if (item.status === 'VERIFIED_DELETED') {
        return item;
      }
      try {
        const result = await this.store.deleteAndVerify(item.location);
        if (!result.ok) {
          return { ...item, status: 'FAILED' as const };
        }
      } catch {
        return { ...item, status: 'FAILED' as const };
      }
      return { ...item, status: 'VERIFIED_DELETED' as const };
    });

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
