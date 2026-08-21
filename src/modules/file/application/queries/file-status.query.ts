import { Inject, Injectable } from '@nestjs/common';
import { FileState, FileStateMachine } from '../../domain/state-machines/file-state-machine';
import { FILE_REPOSITORY } from '../../infrastructure/file-repository';
import type { FileRepository } from '../../infrastructure/file-repository';

/** 状态查询前置失败（IFC-ERR-006 文件不存在 / IFC-ERR-003 无权） */
export class FileStatusQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileStatusQueryError';
  }
}

/** 检查/晋升状态查询结果（IFC-FIL-003 真实状态，不伪造） */
export interface FileStatusView {
  readonly fileId: string;
  readonly state: FileState;
  /** 检查状态：RUNNING/PASSED/FAILED/QUARANTINED/UNAVAILABLE（检查中时） */
  readonly checkStatus: string | null;
  /** 可重试标志（服务不可用时为 true） */
  readonly retryable: boolean;
  /** 是否可访问（未检查/检查失败/隔离 → false；FORM-007） */
  readonly accessible: boolean;
  /** 脱敏结果（不含危险内容） */
  readonly sanitizedResult: string | null;
}

/**
 * 文件状态查询（IFC-FIL-003）。
 *
 * 必须返回检查、晋升、隔离、失败或可用的真实状态；
 * 依赖不可用时保持不可访问，不得超时自动通过（IFC-ERR-012）。
 * 仅当前上传者或有权业务角色可查（首版：上传者本人或管理角色）。
 */
@Injectable()
export class FileStatusQuery {
  constructor(
    @Inject(FILE_REPOSITORY) private readonly repo: FileRepository,
    private readonly stateMachine: FileStateMachine = new FileStateMachine(),
  ) {}

  async getStatus(fileId: string, principalId: string): Promise<FileStatusView> {
    const file = await this.repo.load(fileId);
    if (file === null) {
      throw new FileStatusQueryError('IFC-ERR-006: 文件不存在');
    }
    if (file.uploaderId !== principalId) {
      // 首版：仅上传者可查；有权业务角色（管理员）接入后扩展
      throw new FileStatusQueryError('IFC-ERR-003: 当前无权查询该文件状态');
    }
    return {
      fileId,
      state: file.state,
      checkStatus: file.checkRecord?.status ?? null,
      retryable: file.checkRecord?.retryable ?? false,
      accessible: !this.stateMachine.isUnsafe(file.state),
      sanitizedResult: file.checkRecord?.sanitizedResult ?? null,
    };
  }
}
