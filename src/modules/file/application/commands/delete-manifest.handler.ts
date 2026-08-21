import { Inject, Injectable } from '@nestjs/common';
import { FileState, FileStateMachine } from '../../domain/state-machines/file-state-machine';
import type { FileRecord } from '../../domain/models/file-model';
import { FILE_REPOSITORY } from '../../infrastructure/file-repository';
import type { FileRepository } from '../../infrastructure/file-repository';
import { OBJECT_STORE_PORT } from '../../infrastructure/object-store-port';
import type { ObjectStorePort } from '../../infrastructure/object-store-port';

/** 删除清单执行结果 */
export interface DeleteManifestResult {
  readonly fileId: string;
  /** 全部项回读核验删除 → true；任一项失败 → false（保持未完成） */
  readonly completed: boolean;
  readonly verified: number;
  readonly failed: number;
}

/**
 * 删除清单逐项执行与核验（IFC-FIL-008/009、IFC-TX-007、AUD-008）。
 *
 * - 对清单每项（在线原件/隔离副本/派生物/未过期导出）**逐项删除并回读核验**；
 * - **任一步失败保持未完成**（状态待清理，不宣称正式删除完成），持续重试；
 * - 全部确认删除 → 正式删除（终态）；
 * - 恢复后重放删除清单并核对数据库—对象一致性未收口前，不得宣称文件恢复完成
 *   （IFC-FIL-009；恢复/对账任务按此端口重放）。
 */
@Injectable()
export class DeleteManifestHandler {
  constructor(
    @Inject(FILE_REPOSITORY) private readonly repo: FileRepository,
    @Inject(OBJECT_STORE_PORT) private readonly store: ObjectStorePort,
    private readonly stateMachine: FileStateMachine = new FileStateMachine(),
  ) {}

  async execute(fileId: string): Promise<DeleteManifestResult> {
    const file = await this.repo.load(fileId);
    if (file === null) {
      throw new Error('IFC-ERR-006: 文件不存在');
    }
    const manifest = file.deletionManifest;
    if (manifest === null) {
      throw new Error('IFC-ERR-006: 不存在删除清单');
    }
    if (file.state !== FileState.PENDING_CLEANUP) {
      throw new Error(`IFC-ERR-006: 文件不在待清理状态（当前 ${file.state}）`);
    }

    let verified = 0;
    let failed = 0;
    const items = await Promise.all(
      manifest.items.map(async (item) => {
        if (item.status === 'VERIFIED_DELETED') {
          verified++;
          return item;
        }
        const result = await this.store.deleteAndVerify(item.location);
        if (!result.ok) {
          failed++;
          return { ...item, status: 'FAILED' as const };
        }
        verified++;
        return { ...item, status: 'VERIFIED_DELETED' as const };
      }),
    );

    const completed = failed === 0 && verified === manifest.items.length && manifest.items.length > 0;
    const state = completed
      ? this.stateMachine.transition(FileState.PENDING_CLEANUP, FileState.FORMALLY_DELETED)
      : FileState.PENDING_CLEANUP; // 部分失败：保持未完成，不宣称完成

    const updated: FileRecord = {
      ...file,
      state,
      deletionManifest: { ...manifest, items },
    };
    await this.repo.save(updated);
    return { fileId, completed, verified, failed };
  }
}
