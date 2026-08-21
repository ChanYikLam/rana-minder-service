import { Inject, Injectable } from '@nestjs/common';
import { FileState, FileStateMachine } from '../../domain/state-machines/file-state-machine';
import { BucketRole } from '../../domain/models/file-model';
import type {
  DeleteManifest,
  DeleteManifestItem,
  FileRecord,
  ObjectLocation,
} from '../../domain/models/file-model';
import { FILE_REPOSITORY } from '../../infrastructure/file-repository';
import type { FileRepository } from '../../infrastructure/file-repository';
import { locationKeyOf } from '../../domain/services/object-location';

/** 正式删除输入（IFC-FIL-008/IFC-TX-007：仅超管；范围/二次确认/传播） */
export interface QueueFormalDeleteInput {
  readonly fileId: string;
  /** 发起者（仅超管角色可发起） */
  readonly initiator: { principalId: string; roles: readonly string[] };
  /** 删除原因（超管二次确认；AUD-008） */
  readonly reason: string;
  /**
   * 独立二次确认凭据（AUD-008：超管删除需显式独立确认，不能仅凭任意原因字符串触发）。
   * 由审计/前台二次确认流程签发的一次性确认码或审计令牌；与 reason 分离存证。
   */
  readonly confirmationCode: string;
}

/** 正式删除前置失败（IFC-ERR-003 当前无权 / IFC-ERR-006 前置条件失败） */
export class FormalDeleteError extends Error {
  constructor(code: 'IFC-ERR-003' | 'IFC-ERR-006', message: string) {
    super(`${code}: ${message}`);
    this.name = 'FormalDeleteError';
  }
}

/** 独立二次确认凭据最小长度（AUD-008：防任意短字符串绕过二次确认语义） */
export const MIN_CONFIRMATION_CODE_LENGTH = 6;

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
    // AUD-008：独立二次确认凭据须由审计/前台二次确认流程签发，命令层校验其具备最小强度
    // （≥6 位），避免任意短字符串/单个字符轻易绕过"独立二次确认"语义（AUD-007~009）。
    const confirmationCode = input.confirmationCode.trim();
    if (confirmationCode.length === 0) {
      throw new FormalDeleteError('IFC-ERR-006', '正式删除缺少独立二次确认凭据');
    }
    if (confirmationCode.length < MIN_CONFIRMATION_CODE_LENGTH) {
      throw new FormalDeleteError(
        'IFC-ERR-006',
        `正式删除二次确认凭据长度不足（至少 ${MIN_CONFIRMATION_CODE_LENGTH} 位）`,
      );
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

    // 先撤权：可用/已绑定提交 → 待清理（访问立即撤销）；
    // 已在待清理（如先前经草稿移除/替换进入，且未被清理任务收口）时保持原状态，避免
    // 状态机非法自转换（IFC-ERR-006：PENDING_CLEANUP -> PENDING_CLEANUP 未定义）。
    // revokedState：撤权后的文件状态（访问已撤销、待系统物理清理）。
    const revokedState =
      file.state === FileState.PENDING_CLEANUP
        ? FileState.PENDING_CLEANUP
        : this.stateMachine.transition(file.state, FileState.PENDING_CLEANUP);
    const now = new Date().toISOString();

    // 删除清单：枚举全部版本对象（权威原件 + 隔离副本），并合并受控清理队列中
    // 未删除对象（先经草稿删除/替换进入 PENDING_CLEANUP 时 cleanupQueue 已登记对象，
    // 若遗漏会与清单重复枚举同一对象且元数据残留 PENDING）。按 location 去重。
    // 派生物/导出由审计模块按 AUD-008 传播范围补充（本模块模型未持有派生物定位时留空）。
    const manifestItems = new Map<string, DeleteManifestItem>();
    // bucket 角色 → 清单项类别映射（精确区分 OBJECT/QUARANTINE/DERIVED，不把派生区误标为隔离）
    const KIND_BY_BUCKET: Record<BucketRole, DeleteManifestItem['kind']> = {
      [BucketRole.OBJECT]: 'OBJECT',
      [BucketRole.QUARANTINE]: 'QUARANTINE',
      [BucketRole.DERIVED]: 'DERIVED',
    };
    const addItem = (loc: ObjectLocation): void => {
      const key = locationKeyOf(loc);
      if (!manifestItems.has(key)) {
        manifestItems.set(key, {
          location: loc,
          kind: KIND_BY_BUCKET[loc.bucketRole],
          status: 'PENDING' as const,
        });
      }
    };
    // cleanupQueue 中已 VERIFIED_DELETED 的对象物理已删，无需再入清单；
    // 这些已删对象同样可能被 file.versions 枚举到（如先前经替换/移除入队后已物理删除），
    // 因此先建已删集合，枚举版本时一并跳过，避免已物理删除的对象被重复登记为新 PENDING 项。
    const verifiedDeleted = new Set(
      file.cleanupQueue
        .filter((q) => q.status === 'VERIFIED_DELETED')
        .map((q) => locationKeyOf(q.location)),
    );
    for (const v of file.versions) {
      if (!verifiedDeleted.has(locationKeyOf(v.objectLocation))) {
        addItem(v.objectLocation);
      }
    }
    // cleanupQueue 中未删除的对象并入清单（先经草稿删除/替换进入 PENDING_CLEANUP 时
    // cleanupQueue 已登记对象；已删集合已排除，未删对象补入清单，避免元数据残留 PENDING）
    for (const q of file.cleanupQueue) {
      if (q.status !== 'VERIFIED_DELETED') {
        addItem(q.location);
      }
    }
    const items: readonly DeleteManifestItem[] = [...manifestItems.values()];

    const manifest: DeleteManifest = {
      fileId: file.fileId,
      reason: input.reason,
      confirmationCode,
      initiatedBy: input.initiator.principalId,
      initiatedAt: now,
      accessRevoked: true,
      items,
    };
    // 正式删除接管后，物理删除统一由 deletionManifest 逐项执行并回读核验；
    // 清空 cleanupQueue，避免同一对象被两套机制重复管理/元数据残留 PENDING。
    const updated: FileRecord = {
      ...file,
      state: revokedState,
      cleanupQueue: [],
      deletionManifest: manifest,
    };
    await this.repo.save(updated);
    return manifest;
  }
}
