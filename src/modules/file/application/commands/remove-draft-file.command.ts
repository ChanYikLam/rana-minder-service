import { Inject, Injectable } from '@nestjs/common';
import { FileState, FileStateMachine } from '../../domain/state-machines/file-state-machine';
import type { CleanupQueueItem, FileRecord } from '../../domain/models/file-model';
import { FILE_REPOSITORY } from '../../infrastructure/file-repository';
import type { FileRepository } from '../../infrastructure/file-repository';

/** 移除草稿文件输入（FORM-009/AUD-008） */
export interface RemoveDraftFileInput {
  readonly fileId: string;
  /** 草稿可移除（草稿阶段） */
  readonly removable: boolean;
  /** 是否为正式删除流程接管（超管正式删除；否则普通用户不得物理删除已提交附件） */
  readonly formalDeleteTakeover?: boolean;
}

/** 移除前置失败 */
export class RemoveDraftFileError extends Error {
  constructor(code: 'IFC-ERR-003' | 'IFC-ERR-006', message: string) {
    super(`${code}: ${message}`);
    this.name = 'RemoveDraftFileError';
  }
}

/**
 * 移除草稿文件（IFC-FIL-006/007、FORM-009、AUD-008）。
 *
 * - 草稿中删除：对用户**立即不可见**（状态 → 待清理），系统稍后安全物理清理
 *   （cleanupQueue 登记；清理由后台任务执行）；
 * - **正式提交过的附件不允许普通用户物理删除**（仅超管正式删除流程接管）；
 * - 存在任一有效引用时拒绝清理（本命令只处理草稿/失去引用的文件）。
 */
@Injectable()
export class RemoveDraftFileCommand {
  constructor(
    @Inject(FILE_REPOSITORY) private readonly repo: FileRepository,
    private readonly stateMachine: FileStateMachine = new FileStateMachine(),
  ) {}

  async execute(input: RemoveDraftFileInput): Promise<FileRecord> {
    const file = await this.repo.load(input.fileId);
    if (file === null) {
      throw new RemoveDraftFileError('IFC-ERR-006', '文件不存在');
    }
    if (file.state === FileState.BOUND_TO_SUBMISSION && !input.formalDeleteTakeover) {
      throw new RemoveDraftFileError(
        'IFC-ERR-006',
        '已正式提交的附件不允许普通用户物理删除',
      );
    }
    if (file.state === FileState.CLEANED || file.state === FileState.FORMALLY_DELETED) {
      throw new RemoveDraftFileError('IFC-ERR-006', '文件已是终态');
    }
    if (file.state === FileState.PENDING_CLEANUP) {
      return file; // 幂等：已在待清理
    }

    const now = new Date().toISOString();
    // 立即不可见：可用/隔离/临时上传 → 待清理（状态机校验）
    const state = this.stateMachine.transition(file.state, FileState.PENDING_CLEANUP);

    // 全部版本对象进入受控清理（对用户不可见后由系统稍后物理清理）
    const newQueue: readonly CleanupQueueItem[] = file.versions
      .filter((v) => v.objectLocation.bucketRole !== 'QUARANTINE' || file.versions.length === 1)
      .map((v) => ({
        location: v.objectLocation,
        reason: 'REMOVED' as const,
        queuedAt: now,
        status: 'PENDING' as const,
      }));

    const updated: FileRecord = {
      ...file,
      state,
      cleanupQueue: [...file.cleanupQueue, ...newQueue],
    };
    await this.repo.save(updated);
    return updated;
  }
}
