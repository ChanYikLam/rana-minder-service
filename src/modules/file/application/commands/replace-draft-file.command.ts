import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { FileState, FileStateMachine } from '../../domain/state-machines/file-state-machine';
import { BucketRole } from '../../domain/models/file-model';
import type {
  CleanupQueueItem,
  FileRecord,
  ObjectLocation,
  UploadSession,
  FileVersion,
} from '../../domain/models/file-model';
import { UploadPolicy } from '../../domain/services/upload-policy';
import { locationKeyOf } from '../../domain/services/object-location';
import { FILE_REPOSITORY } from '../../infrastructure/file-repository';
import type { FileRepository } from '../../infrastructure/file-repository';

/** 替换草稿文件输入（IFC-FIL-006） */
export interface ReplaceDraftFileInput {
  readonly fileId: string;
  /** 业务允许编辑（草稿可自由替换；已提交表单仅在业务允许编辑时可替换） */
  readonly editable: boolean;
  /** 新版本声明大小（重新上传检查；平台硬上限） */
  readonly declaredSizeBytes: number;
  /** 新版本声明类型 */
  readonly declaredType?: string;
  /** 字段附件数量上限（不得突破平台硬上限） */
  readonly configuredPerField?: number;
}

/** 替换前置失败（IFC-ERR-006：已提交锁定只能走事实纠错；隔离文件重新上传必须新建文件） */
export class ReplaceDraftFileError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-006: ${message}`);
    this.name = 'ReplaceDraftFileError';
  }
}

/**
 * 替换草稿文件（IFC-FIL-006，SRS-SM-FILE-001）。
 *
 * - 草稿中文件可自由替换：产生**新文件版本**（新不可变版本 + 新隔离区上传会话），
 *   旧临时引用进入**受控清理**（cleanupQueue），**不覆盖已检查原件**；
 * - 已提交表单仅在业务允许编辑时可替换（旧文件继续绑旧提交修订）；
 * - 已提交锁定后只能走事实纠错（拒绝替换）；
 * - 隔离/失败文件重新上传必须**新建文件**（不允许在本文件上替换）。
 */
@Injectable()
export class ReplaceDraftFileCommand {
  constructor(
    @Inject(FILE_REPOSITORY) private readonly repo: FileRepository,
    private readonly policy: UploadPolicy,
    private readonly stateMachine: FileStateMachine = new FileStateMachine(),
  ) {}

  async execute(input: ReplaceDraftFileInput): Promise<FileRecord> {
    if (!input.editable) {
      throw new ReplaceDraftFileError('已提交表单已锁定，只能走事实纠错');
    }
    const file = await this.repo.load(input.fileId);
    if (file === null) {
      throw new ReplaceDraftFileError('文件不存在');
    }
    // 替换仅对已可用（检查通过）的草稿文件；隔离/失败必须新建文件
    if (file.state !== FileState.AVAILABLE) {
      throw new ReplaceDraftFileError(
        `当前状态 ${file.state} 不可替换（隔离/失败/已提交需新建文件或走纠错）`,
      );
    }
    // 平台硬上限（新版本声明大小与字段数量）
    this.policy.assertDeclaredSizeWithinLimit(file.category, input.declaredSizeBytes);
    if (input.configuredPerField !== undefined) {
      this.policy.assertCountWithinLimit(input.configuredPerField);
    }

    const now = new Date().toISOString();
    const nextVersionNo = await this.repo.nextVersionNo(file.fileId);
    const oldVersion = file.versions[file.versions.length - 1];
    // 防御：可用文件必存在至少一个版本（替换产生的新版本追加于其后，旧原件入受控清理）
    if (oldVersion === undefined) {
      throw new ReplaceDraftFileError('文件无版本对象，无法替换');
    }

    // 新版本：新隔离区对象 + 新上传会话（旧原件不覆盖）
    const quarantine: ObjectLocation = {
      bucketRole: BucketRole.QUARANTINE,
      keyVersion: 'v1',
      randomKey: `${randomUUID()}${randomUUID()}`,
      objectKind: 'UPLOAD',
      actualSize: 0,
      sha256: '',
      storageToken: randomUUID(),
    };
    const session: UploadSession = {
      sessionId: randomUUID(),
      fileVersionNo: nextVersionNo,
      isolationLocation: quarantine,
      allowedCategory: file.category,
      maxSizeBytes: this.policy.maxSizeFor(file.category),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      status: 'ACTIVE',
    };
    const newVersion: FileVersion = {
      versionNo: nextVersionNo,
      objectLocation: quarantine,
      declaredType: input.declaredType ?? '',
      detectedType: null,
      declaredSize: input.declaredSizeBytes,
      actualSize: null,
      sha256: null,
      createdAt: now,
    };

    // 旧版本进入受控清理（失去最后有效引用；不覆盖已检查原件）
    // 按 location 去重：同一对象（如先前替换/删除已入队）不得重复登记，避免清理队列
    // 出现重复项导致同一对象被删除两次/元数据冗余。
    const alreadyQueued = file.cleanupQueue.some(
      (i) => locationKeyOf(i.location) === locationKeyOf(oldVersion.objectLocation),
    );
    const cleanupQueue: readonly CleanupQueueItem[] = alreadyQueued
      ? file.cleanupQueue
      : [
          ...file.cleanupQueue,
          {
            location: oldVersion.objectLocation,
            reason: 'REPLACED',
            queuedAt: now,
            status: 'PENDING',
          },
        ];

    const state = this.stateMachine.transition(FileState.AVAILABLE, FileState.TEMPORARY_UPLOAD);
    const updated: FileRecord = {
      ...file,
      state,
      versionNo: nextVersionNo,
      versions: [...file.versions, newVersion],
      uploadSession: session,
      checkRecord: null,
      cleanupQueue,
    };
    await this.repo.save(updated);
    return updated;
  }
}
