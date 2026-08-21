import { Inject, Injectable } from '@nestjs/common';
import { FileState, FileStateMachine } from '../../domain/state-machines/file-state-machine';
import { FileTypeGuard } from '../../domain/services/file-type-guard';
import { BucketRole } from '../../domain/models/file-model';
import type { FileRecord } from '../../domain/models/file-model';
import { FILE_REPOSITORY } from '../../infrastructure/file-repository';
import type { FileRepository } from '../../infrastructure/file-repository';
import { OBJECT_STORE_PORT } from '../../infrastructure/object-store-port';
import type { ObjectStorePort } from '../../infrastructure/object-store-port';

/** 完成字节接收输入（IFC-FIL-002） */
export interface CompleteUploadInput {
  readonly fileId: string;
  readonly sessionId: string;
  readonly bytes: Uint8Array;
  /** 实际大小（字节；与声明大小一致性核验） */
  readonly actualSize: number;
}

/** 上传完成前置失败（IFC-ERR-006/IFC-ERR-012） */
export class CompleteUploadError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-006: ${message}`);
    this.name = 'CompleteUploadError';
  }
}

/**
 * 完成字节接收并请求检查（IFC-FIL-002；SRS-SM-FILE-001：临时上传→检查中/隔离失败）。
 *
 * - 隔离对象完整、实际字节可读、上传会话和文件版本匹配；
 * - 字节以**只写一次**写入隔离区（客户端不得指定对象键；重放命中原键失败）；
 * - 真实类型初检：按 magic bytes 校验，不信任扩展名；默认禁止可执行/脚本/
 *   高风险压缩（GOV-008）→ 直接隔离/失败；
 * - 进入检查中并创建权威检查任务；未完成、版本冲突或初检失败不开放访问。
 */
@Injectable()
export class CompleteUploadCommand {
  constructor(
    @Inject(FILE_REPOSITORY) private readonly repo: FileRepository,
    @Inject(OBJECT_STORE_PORT) private readonly store: ObjectStorePort,
    private readonly stateMachine: FileStateMachine = new FileStateMachine(),
    private readonly guard: FileTypeGuard = new FileTypeGuard(),
  ) {}

  async execute(input: CompleteUploadInput): Promise<FileRecord> {
    const file = await this.repo.load(input.fileId);
    if (file === null) {
      throw new CompleteUploadError('文件不存在');
    }
    if (file.state !== FileState.TEMPORARY_UPLOAD) {
      throw new CompleteUploadError(`文件不在临时上传状态（当前 ${file.state}）`);
    }
    const session = file.uploadSession;
    if (session === null || session.sessionId !== input.sessionId) {
      throw new CompleteUploadError('上传会话不匹配');
    }
    if (session.status !== 'ACTIVE') {
      throw new CompleteUploadError('上传会话已封存或过期');
    }
    if (Date.parse(session.expiresAt) < Date.now()) {
      throw new CompleteUploadError('上传会话已过期');
    }
    const currentVersion = file.versions[file.versions.length - 1];
    if (currentVersion.versionNo !== session.fileVersionNo) {
      throw new CompleteUploadError('上传会话与文件版本不匹配');
    }
    // 实际字节可读且大小一致（声明大小上限在初始化时已校验）
    if (input.actualSize <= 0 || input.actualSize !== currentVersion.declaredSize) {
      throw new CompleteUploadError('实际大小与声明大小不一致');
    }

    // 隔离区只写一次写入（重放命中原隔离键失败；DATA-FIL-002）
    const put = await this.store.putQuarantine(session.isolationLocation, input.bytes);
    if (!put.ok) {
      throw new CompleteUploadError(`隔离区写入失败：${put.reason ?? 'unknown'}`);
    }

    // 真实类型初检（不信任扩展名；默认禁止可执行/脚本/高风险压缩）
    const sniff = this.guard.check(input.bytes, currentVersion.declaredType);
    const initialCheck =
      sniff.outcome === 'PASSED'
        ? 'PASSED'
        : sniff.outcome === 'QUARANTINED'
          ? 'QUARANTINED'
          : 'FAILED';

    // 状态转换：临时上传 → 检查中（初检通过）或 隔离/失败（初检拒绝）
    const to =
      initialCheck === 'PASSED' ? FileState.CHECKING : FileState.QUARANTINED_FAILED;
    const state = this.stateMachine.transition(FileState.TEMPORARY_UPLOAD, to);

    const updatedVersion = {
      ...currentVersion,
      actualSize: input.actualSize,
      detectedType: sniff.detectedType,
    };
    const updated: FileRecord = {
      ...file,
      state,
      versions: [...file.versions.slice(0, -1), updatedVersion],
      uploadSession: { ...session, status: 'SEALED' },
      checkRecord: {
        fileVersionNo: updatedVersion.versionNo,
        engineVersion: 'app-initial-v1',
        status: initialCheck === 'PASSED' ? 'RUNNING' : initialCheck,
        retryable: false,
        sanitizedResult: sniff.matchesDeclaration ? sniff.detectedType : `declared-mismatch:${sniff.detectedType}`,
        startedAt: new Date().toISOString(),
      },
    };
    await this.repo.save(updated);
    return updated;
  }
}
