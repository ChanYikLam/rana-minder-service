import { Inject, Injectable } from '@nestjs/common';
import { FileState, FileStateMachine } from '../../domain/state-machines/file-state-machine';
import type { FileRecord } from '../../domain/models/file-model';
import { FILE_REPOSITORY } from '../../infrastructure/file-repository';
import type { FileRepository } from '../../infrastructure/file-repository';
import { OBJECT_STORE_PORT } from '../../infrastructure/object-store-port';
import type { ObjectStorePort } from '../../infrastructure/object-store-port';

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
      throw new Error('IFC-ERR-006: 文件不存在');
    }
    if (file.state !== FileState.PENDING_CLEANUP) {
      throw new Error(`IFC-ERR-006: 文件不在待清理状态（当前 ${file.state}）`);
    }
    if (file.deletionManifest !== null) {
      throw new Error('IFC-ERR-006: 正式删除清单接管，由删除清单处理');
    }

    const now = new Date().toISOString();
    let allVerified = true;
    const processed = file.cleanupQueue.map(async (item) => {
      if (item.status === 'VERIFIED_DELETED') {
        return item;
      }
      const result = await this.store.deleteAndVerify(item.location);
      if (!result.ok) {
        allVerified = false;
        return { ...item, status: 'FAILED' as const };
      }
      return { ...item, status: 'VERIFIED_DELETED' as const, queuedAt: item.queuedAt };
    });
    const queue = await Promise.all(processed);

    const state = allVerified
      ? this.stateMachine.transition(FileState.PENDING_CLEANUP, FileState.CLEANED)
      : FileState.PENDING_CLEANUP; // 部分失败：保持待清理并持续重试
    const updated: FileRecord = { ...file, state, cleanupQueue: queue };
    await this.repo.save(updated);
    return updated;
  }
}
