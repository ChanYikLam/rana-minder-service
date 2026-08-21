import { Inject, Injectable } from '@nestjs/common';
import { FileState, FileStateMachine } from '../../domain/state-machines/file-state-machine';
import { BucketRole } from '../../domain/models/file-model';
import type {
  DeleteManifest,
  DeleteManifestItem,
  FileRecord,
} from '../../domain/models/file-model';
import { FILE_REPOSITORY } from '../../infrastructure/file-repository';
import type { FileRepository } from '../../infrastructure/file-repository';

/** 正式删除输入（IFC-FIL-008/IFC-TX-007：仅超管；范围/二次确认/传播） */
export interface QueueFormalDeleteInput {
  readonly fileId: string;
  /** 发起者（仅超管角色可发起） */
  readonly initiator: { principalId: string; roles: readonly string[] };
  /** 删除原因（超管二次确认；AUD-008） */
  readonly reason: string;
}

/** 正式删除前置失败（IFC-ERR-003 当前无权 / IFC-ERR-006 前置条件失败） */
export class FormalDeleteError extends Error {
  constructor(code: 'IFC-ERR-003' | 'IFC-ERR-006', message: string) {
    super(`${code}: ${message}`);
    this.name = 'FormalDeleteError';
  }
}

/**
 * 正式删除排队（IFC-FIL-008、IFC-TX-007）。
 *
 * - **仅超管**按 AUD-007~009 的范围/预览/二次确认执行（普通用户无此能力）；
 * - **先撤权**（状态 → 待清理，访问立即撤销）再生成删除清单；
 * - 删除清单枚举在线原件、隔离副本、派生物与未过期导出（传播范围由审计模块
 *   按 AUD-008 提供；本模块枚举文件版本对象）；
 * - 部分失败不得宣称完成：清单执行由 DeleteManifestHandler 逐项核验。
 */
@Injectable()
export class QueueFormalDeleteCommand {
  constructor(
    @Inject(FILE_REPOSITORY) private readonly repo: FileRepository,
    private readonly stateMachine: FileStateMachine = new FileStateMachine(),
  ) {}

  async execute(input: QueueFormalDeleteInput): Promise<DeleteManifest> {
    if (!input.initiator.roles.includes('SUPER_ADMIN')) {
      throw new FormalDeleteError('IFC-ERR-003', '仅超级管理员可发起正式删除');
    }
    if (input.reason.trim().length === 0) {
      throw new FormalDeleteError('IFC-ERR-006', '正式删除需要二次确认原因');
    }
    const file = await this.repo.load(input.fileId);
    if (file === null) {
      throw new FormalDeleteError('IFC-ERR-006', '文件不存在');
    }
    if (file.state === FileState.CLEANED || file.state === FileState.FORMALLY_DELETED) {
      throw new FormalDeleteError('IFC-ERR-006', '文件已是终态');
    }
    if (file.deletionManifest !== null) {
      return file.deletionManifest; // 幂等：清单已存在
    }

    // 先撤权：可用/已绑定提交 → 待清理（访问立即撤销）
    const revoked = this.stateMachine.transition(file.state, FileState.PENDING_CLEANUP);
    const now = new Date().toISOString();

    // 删除清单：枚举全部版本对象（权威原件 + 隔离副本）；派生物/导出由审计模块
    // 按 AUD-008 传播范围补充（本模块模型未持有派生物定位时留空，接入后枚举）
    const items: readonly DeleteManifestItem[] = file.versions.map((v) => ({
      location: v.objectLocation,
      kind: v.objectLocation.bucketRole === BucketRole.OBJECT ? 'OBJECT' : 'QUARANTINE',
      status: 'PENDING' as const,
    }));

    const manifest: DeleteManifest = {
      fileId: file.fileId,
      reason: input.reason,
      initiatedBy: input.initiator.principalId,
      initiatedAt: now,
      accessRevoked: true,
      items,
    };
    const updated: FileRecord = {
      ...file,
      state: revoked,
      deletionManifest: manifest,
    };
    await this.repo.save(updated);
    return manifest;
  }
}
