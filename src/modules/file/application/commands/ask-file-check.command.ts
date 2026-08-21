import { Inject, Injectable } from '@nestjs/common';
import { FileState, FileStateMachine } from '../../domain/state-machines/file-state-machine';
import type { FileRecord } from '../../domain/models/file-model';
import { FILE_REPOSITORY } from '../../infrastructure/file-repository';
import type { FileRepository } from '../../infrastructure/file-repository';
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
  /** 检查用字节（隔离区回读；不信任客户端提交） */
  readonly bytes: Uint8Array;
  /** 声明类型（初检登记；检查按真实类型执行） */
  readonly declaredType: string;
}

/**
 * 请求文件检查（IFC-FIL-002/003；幂等）。
 *
 * - 只对检查中状态执行；检查结果绑定文件哈希/版本；
 * - 重复回调幂等（同一文件同一检查版本不重复执行）；
 * - 外部检查服务不可用 → UNAVAILABLE（可重试），保持不可访问；
 * - **客户端不得自行宣布检查通过**：本命令只更新检查记录，收口由
 *   PromoteFileCommand（服务端任务）执行。
 */
@Injectable()
export class AskFileCheckCommand {
  constructor(
    @Inject(FILE_REPOSITORY) private readonly repo: FileRepository,
    @Inject(FILE_CHECK_PORT) private readonly checkPort: FileCheckPort,
    private readonly stateMachine: FileStateMachine = new FileStateMachine(),
  ) {}

  async execute(input: AskFileCheckInput): Promise<FileCheckResult> {
    const file = await this.repo.load(input.fileId);
    if (file === null) {
      throw new AskFileCheckError('文件不存在');
    }
    if (file.state !== FileState.CHECKING) {
      throw new AskFileCheckError(`文件不在检查中状态（当前 ${file.state}）`);
    }
    const check = file.checkRecord;
    // 幂等：已收口（终态）不重复执行
    if (
      check !== null &&
      (check.status === 'PASSED' ||
        check.status === 'FAILED' ||
        check.status === 'QUARANTINED')
    ) {
      return this.toResult(check.status, check.engineVersion, check.sanitizedResult, false);
    }
    // 执行检查（外部服务适配；不可用必须返回 UNAVAILABLE，不得放行）
    const result = await this.checkPort.check(file, input.bytes, input.declaredType);
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
