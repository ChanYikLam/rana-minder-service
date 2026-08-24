import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { FileState, FileStateMachine } from '../../domain/state-machines/file-state-machine';
import type { FileRecord } from '../../domain/models/file-model';
import { FILE_REPOSITORY } from '../../infrastructure/file-repository';
import type { FileRepository } from '../../infrastructure/file-repository';
import { OBJECT_STORE_PORT } from '../../infrastructure/object-store-port';
import type { ObjectStorePort } from '../../infrastructure/object-store-port';
import { FILE_CHECK_PORT } from '../../infrastructure/file-check-port';
import type { FileCheckPort, FileCheckResult } from '../../infrastructure/file-check-port';

/** 请求检查失败（IFC-ERR-006：文件不存在/状态不符等前置失败） */
export class AskFileCheckError extends Error {
  constructor(message: string) {
    super(`IFC-ERR-006: ${message}`);
    this.name = 'AskFileCheckError';
  }
}

/** 请求检查输入（AskFileCheckCommand；job 模块编排，稳定回调/轮询收口） */
export interface AskFileCheckInput {
  readonly fileId: string;
  /** 操作主体（归属/权限鉴权；IFC-FIL-003 一致：仅上传者或有权角色） */
  readonly principalId: string;
}

/**
 * 请求文件检查（IFC-FIL-002/003；幂等）。
 *
 * - 只对检查中状态执行；检查结果绑定文件哈希/版本；
 * - **检查字节取自隔离区权威对象，不信任调用方提交的字节**：命令从对象存储
 *   回读隔离对象，并按版本记录中的可信 SHA-256 校验一致后才执行外部检查，
 *   防止调用方用任意字节冒充原件通过检查；
 * - 声明类型取自版本记录（客户端声明仅登记，不信任）；
 * - 重复回调幂等（同一文件同一检查版本不重复执行）；
 * - 外部检查服务不可用 → UNAVAILABLE（可重试），保持不可访问；
 * - **客户端不得自行宣布检查通过**：本命令只更新检查记录，收口由
 *   PromoteFileCommand（服务端任务）执行。
 */
@Injectable()
export class AskFileCheckCommand {
  constructor(
    @Inject(FILE_REPOSITORY) private readonly repo: FileRepository,
    @Inject(OBJECT_STORE_PORT) private readonly store: ObjectStorePort,
    @Inject(FILE_CHECK_PORT) private readonly checkPort: FileCheckPort,
    private readonly stateMachine: FileStateMachine = new FileStateMachine(),
  ) {}

  async execute(input: AskFileCheckInput): Promise<FileCheckResult> {
    const file = await this.repo.load(input.fileId);
    if (file === null) {
      throw new AskFileCheckError('文件不存在');
    }
    if (file.uploaderId !== input.principalId) {
      throw new AskFileCheckError('当前无权请求该文件检查');
    }
    if (file.state !== FileState.CHECKING) {
      throw new AskFileCheckError(`文件不在检查中状态（当前 ${file.state}）`);
    }
    const check = file.checkRecord;
    // 幂等：已收口（终态）不重复执行
    if (
      check !== null &&
      (check.status === 'PASSED' || check.status === 'FAILED' || check.status === 'QUARANTINED')
    ) {
      return this.toResult(check.status, check.engineVersion, check.sanitizedResult, false);
    }

    // 从隔离区回读权威对象字节（不信任调用方提交的字节）
    const currentVersion = file.versions[file.versions.length - 1];
    const bytes = await this.store.read(currentVersion.objectLocation);
    if (bytes === null) {
      throw new AskFileCheckError('隔离区对象不可读');
    }
    // 按版本记录的可信 SHA-256 核验实际字节，防止字节与原件不符时被错误放行
    const expectedSha256 = currentVersion.sha256;
    if (expectedSha256 === null || expectedSha256.length === 0) {
      throw new AskFileCheckError('缺少可信摘要，拒绝执行检查');
    }
    if (this.sha256Hex(bytes) !== expectedSha256) {
      throw new AskFileCheckError('隔离区字节与可信摘要不一致');
    }

    // 声明类型取自版本记录（客户端声明仅登记，不信任）
    const declaredType = currentVersion.declaredType;
    const result = await this.checkPort.check(file, bytes, declaredType);
    const updated: FileRecord = {
      ...file,
      checkRecord: {
        fileVersionNo: file.versionNo,
        engineVersion: result.engineVersion,
        status:
          result.outcome === 'PASSED'
            ? 'PASSED'
            : result.outcome === 'QUARANTINED'
              ? 'QUARANTINED'
              : result.outcome === 'FAILED'
                ? 'FAILED'
                : 'UNAVAILABLE',
        retryable: result.retryable,
        sanitizedResult: result.sanitizedResult,
        startedAt: file.checkRecord?.startedAt ?? new Date().toISOString(),
        finishedAt: result.outcome === 'UNAVAILABLE' ? undefined : new Date().toISOString(),
      },
    };
    await this.repo.save(updated);
    return result;
  }

  private sha256Hex(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  private toResult(
    status: 'PASSED' | 'FAILED' | 'QUARANTINED',
    engineVersion: string,
    sanitizedResult: string,
    retryable: boolean,
  ): FileCheckResult {
    const outcome =
      status === 'PASSED'
        ? ('PASSED' as const)
        : status === 'QUARANTINED'
          ? ('QUARANTINED' as const)
          : ('FAILED' as const);
    return { outcome, engineVersion, sanitizedResult, retryable };
  }
}
