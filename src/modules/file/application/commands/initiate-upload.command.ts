import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  FileCategory,
  FileRecord,
  ObjectLocation,
  UploadSession,
  FileVersion,
} from '../../domain/models/file-model';
import { BucketRole } from '../../domain/models/file-model';
import { FileState, FileStateMachine } from '../../domain/state-machines/file-state-machine';
import { UploadPolicy } from '../../domain/services/upload-policy';
import { randomObjectKey } from '../../domain/services/object-location';
import { FILE_REPOSITORY } from '../../infrastructure/file-repository';
import type { FileRepository } from '../../infrastructure/file-repository';
import { DEFAULT_SESSION_TTL_MINUTES, MAX_SESSION_TTL_MINUTES } from './session-ttl';
export { MAX_SESSION_TTL_MINUTES };

/** 上传初始化输入（IFC-FIL-001） */
export interface InitiateUploadInput {
  readonly uploaderId: string;
  /** 创建作用域（社团/联合域/主体） */
  readonly scope: { kind: string; clubId?: string; unionId?: string; subjectId?: string };
  /** 业务类别（表单管理员只选照片/视频/普通文件，不得突破平台硬上限） */
  readonly category: FileCategory;
  /** 声明大小（字节；平台硬上限校验） */
  readonly declaredSizeBytes: number;
  /** 声明类型（客户端声明；不信任，仅登记，检查时按真实类型校验） */
  readonly declaredType?: string;
  /** 目标草稿/纠错对象与字段（IFC-FIL-001：当前草稿/字段可写） */
  readonly target: { objectType: string; objectId: string; fieldKey: string };
  /** 字段配置的附件数量上限（校验不得突破平台硬上限；可选） */
  readonly configuredPerField?: number;
  /** 上传会话有效期（分钟；默认 30） */
  readonly sessionTtlMinutes?: number;
}

/** 前置条件失败（无权/越界/数量大小越限不创建文件；IFC-FIL-001） */
export class InitiateUploadError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-006: ${message}`);
    this.name = 'InitiateUploadError';
  }
}

/**
 * 初始化上传（IFC-FIL-001，SRS-SM-FILE-001：新建→临时上传）。
 *
 * - 类别/数量/声明大小在平台硬上限内（社团及表单管理员不得放宽）；
 * - 原子保存文件元数据、不可变版本和**只指向隔离区**的限时上传会话；
 * - 客户端不得决定对象键；无权或越界不创建文件。
 */
@Injectable()
export class InitiateUploadCommand {
  constructor(
    @Inject(FILE_REPOSITORY) private readonly repo: FileRepository,
    private readonly policy: UploadPolicy,
    private readonly stateMachine: FileStateMachine = new FileStateMachine(),
  ) {}

  async execute(input: InitiateUploadInput): Promise<FileRecord> {
    // 平台硬上限：单文件声明大小（类别维度）
    this.policy.assertDeclaredSizeWithinLimit(input.category, input.declaredSizeBytes);
    // 字段附件数量硬上限：真正执行（IFC-FIL-001），不得仅靠表单侧维护计数
    let configuredPerField: number | undefined;
    if (input.configuredPerField !== undefined) {
      // 配置数不得超过平台硬上限
      this.policy.assertCountWithinLimit(input.configuredPerField);
      configuredPerField = input.configuredPerField;
    }

    const now = new Date().toISOString();
    const fileId = randomUUID();
    const versionNo = 1;
    const quarantine: ObjectLocation = {
      bucketRole: BucketRole.QUARANTINE,
      keyVersion: 'v1',
      randomKey: randomObjectKey(),
      objectKind: 'UPLOAD',
      actualSize: 0,
      sha256: '',
      storageToken: randomUUID(),
    };
    const ttlMinutes = input.sessionTtlMinutes ?? DEFAULT_SESSION_TTL_MINUTES;
    if (ttlMinutes <= 0 || ttlMinutes > MAX_SESSION_TTL_MINUTES) {
      throw new InitiateUploadError(
        `上传会话有效期需在 1~${MAX_SESSION_TTL_MINUTES} 分钟内（当前 ${ttlMinutes}）`,
      );
    }
    const session: UploadSession = {
      sessionId: randomUUID(),
      fileVersionNo: versionNo,
      isolationLocation: quarantine,
      allowedCategory: input.category,
      maxSizeBytes: this.policy.maxSizeFor(input.category),
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
      status: 'ACTIVE',
    };
    const version: FileVersion = {
      versionNo,
      objectLocation: quarantine,
      declaredType: input.declaredType ?? '',
      detectedType: null,
      declaredSize: input.declaredSizeBytes,
      actualSize: null,
      sha256: null,
      createdAt: now,
    };
    // 新建 → 临时上传（状态机校验转换合法）
    const state = this.stateMachine.transition(FileState.NEW, FileState.TEMPORARY_UPLOAD);
    const file: FileRecord = {
      fileId,
      uploaderId: input.uploaderId,
      scope: input.scope,
      category: input.category,
      state,
      target: input.target,
      versionNo,
      versions: [version],
      uploadSession: session,
      checkRecord: null,
      cleanupQueue: [],
      deletionManifest: null,
      createdAt: now,
    };
    // 原子创建：配置数量上限时由仓储在同一同步段内完成"计数+保存"（防 TOCTOU），
    // 已满返回 false；未配置上限走普通保存。
    if (configuredPerField !== undefined) {
      const created = await this.repo.createWithinTargetLimit(
        input.target,
        configuredPerField,
        file,
      );
      if (!created) {
        throw new InitiateUploadError(
          `字段附件数量已达上限（${configuredPerField}），无法继续上传`,
        );
      }
    } else {
      await this.repo.save(file);
    }
    return file;
  }
}
