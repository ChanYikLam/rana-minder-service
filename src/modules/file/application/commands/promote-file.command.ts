import { Inject, Injectable } from '@nestjs/common';
import { FileState, FileStateMachine } from '../../domain/state-machines/file-state-machine';
import { BucketRole } from '../../domain/models/file-model';
import type { FileRecord, ObjectLocation } from '../../domain/models/file-model';
import { FILE_REPOSITORY } from '../../infrastructure/file-repository';
import type { FileRepository } from '../../infrastructure/file-repository';
import { OBJECT_STORE_PORT } from '../../infrastructure/object-store-port';
import type { ObjectStorePort } from '../../infrastructure/object-store-port';

/** 检查收口输入（PromoteFileCommand；服务端/后台任务调用，客户端不得自行宣布检查通过） */
export interface PromoteFileInput {
  readonly fileId: string;
}

/** 晋升失败（IFC-ERR-012 依赖不可用/IFC-ERR-006 前置失败） */
export class PromoteFileError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-012: ${message}`);
    this.name = 'PromoteFileError';
  }
}

/**
 * 检查收口（PromoteFileCommand，IFC-FIL-002/003；SRS-SM-FILE-001 检查中→可用/隔离失败）。
 *
 * - 检查通过：创建晋升意图，以**只写一次**的新键复制到权威原件区，核验大小/可信
 *   SHA-256 后原子收口 → 可用（DATA-FIL-003）；
 * - 检查失败/隔离：检查中 → 隔离/失败（保存脱敏原因；不把危险内容写入日志）；
 * - 检查服务不可用：保持检查中（可重试标志），不得超时自动放行（GOV-008、NFR-003/006）。
 */
@Injectable()
export class PromoteFileCommand {
  constructor(
    @Inject(FILE_REPOSITORY) private readonly repo: FileRepository,
    @Inject(OBJECT_STORE_PORT) private readonly store: ObjectStorePort,
    private readonly stateMachine: FileStateMachine = new FileStateMachine(),
  ) {}

  async execute(input: PromoteFileInput): Promise<FileRecord> {
    const file = await this.repo.load(input.fileId);
    if (file === null) {
      throw new PromoteFileError('文件不存在');
    }
    if (file.state !== FileState.CHECKING) {
      throw new PromoteFileError(`文件不在检查中状态（当前 ${file.state}）`);
    }
    const check = file.checkRecord;
    if (check === null || check.status === 'RUNNING') {
      throw new PromoteFileError('检查尚未收口');
    }

    // 服务不可用：保持检查中（可重试），不得放行。
    // 状态未变且 retryable 已在此前收口置为 true，无需重复写库。
    if (check.status === 'UNAVAILABLE') {
      this.stateMachine.onCheckUnavailable(file.state);
      return file;
    }

    // 失败/隔离：检查中 → 隔离/失败（可重试标志按检查结果）
    if (check.status === 'FAILED' || check.status === 'QUARANTINED') {
      const state = this.stateMachine.transition(FileState.CHECKING, FileState.QUARANTINED_FAILED);
      const updated: FileRecord = { ...file, state, checkRecord: { ...check, retryable: check.retryable } };
      await this.repo.save(updated);
      return updated;
    }

    // 通过：晋升（隔离区 → 权威原件区，只写一次新键；核验大小与可信 SHA-256）
    const currentVersion = file.versions[file.versions.length - 1];
    const quarantine = currentVersion.objectLocation;
    const objectLocation: ObjectLocation = {
      bucketRole: BucketRole.OBJECT,
      keyVersion: 'v1',
      randomKey: quarantine.randomKey, // 复用同熵随机键（键格式前缀不同，互不冲突）
      objectKind: 'OBJECT',
      actualSize: quarantine.actualSize,
      sha256: currentVersion.sha256 ?? '',
      storageToken: quarantine.storageToken,
    };
    const promoted = await this.store.promoteToObject(
      quarantine,
      objectLocation,
      currentVersion.sha256 ?? '',
    );
    if (!promoted.ok) {
      // 晋升失败保持检查中（不开放访问；DATA-FIL-003 源对象变化/目标已存在/核验失败不放行）
      const updated: FileRecord = {
        ...file,
        checkRecord: { ...check, status: 'UNAVAILABLE', retryable: true, sanitizedResult: `promote-failed:${promoted.reason ?? 'unknown'}` },
      };
      await this.repo.save(updated);
      return updated;
    }

    const state = this.stateMachine.transition(FileState.CHECKING, FileState.AVAILABLE);
    const updatedVersion = { ...currentVersion, objectLocation };
    const updated: FileRecord = {
      ...file,
      state,
      versions: [...file.versions.slice(0, -1), updatedVersion],
      checkRecord: { ...check, status: 'PASSED' },
    };
    await this.repo.save(updated);
    return updated;
  }
}
