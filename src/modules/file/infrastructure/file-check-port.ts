import { Injectable } from '@nestjs/common';
import { FileCheckOutcome } from '../domain/state-machines/file-state-machine';
import { FileTypeGuard } from '../domain/services/file-type-guard';
import type { FileRecord } from '../domain/models/file-model';

/** 文件检查端口注入令牌（FileCheckPort 为接口，注入须用显式 token） */
export const FILE_CHECK_PORT = Symbol('FILE_CHECK_PORT');

/** 检查收口结果（IFC-FIL-003 真实状态；脱敏） */
export interface FileCheckResult {
  readonly outcome: FileCheckOutcome;
  /** 规则/引擎版本（DATA-FIL-003 分别记录） */
  readonly engineVersion: string;
  /** 脱敏结果（不得把危险内容写入日志；GOV-008） */
  readonly sanitizedResult: string;
  /** 服务不可用时为 true（可重试标志；不得超时自动放行） */
  readonly retryable: boolean;
}

/**
 * 文件检查服务端口（外部自动技术安全检查服务适配；IFC-FIL-002/003）。
 *
 * 检查按真实文件类型、大小、恶意内容执行；检查中/失败/隔离的文件
 * 不可预览、下载或进入正式提交（DATA-FIL-003）。服务不可用必须返回
 * UNAVAILABLE（保持不可访问），不得超时自动通过（GOV-008、NFR-003/006）。
 */
export interface FileCheckPort {
  check(file: FileRecord, bytes: Uint8Array, declaredType: string): Promise<FileCheckResult>;
}

/**
 * 应用侧初检占位（外部检查服务接入前）。
 *
 * 执行真实类型校验（不信任扩展名、默认禁止可执行/脚本/高风险压缩）；
 * 恶意内容深度检查与安全预览由外部服务接入后替换（引擎版本标识占位）。
 */
@Injectable()
export class ApplicationFileCheck implements FileCheckPort {
  static readonly ENGINE_VERSION = 'app-initial-v1';

  constructor(private readonly guard: FileTypeGuard = new FileTypeGuard()) {}

  async check(file: FileRecord, bytes: Uint8Array, declaredType: string): Promise<FileCheckResult> {
    const sniff = this.guard.check(bytes, declaredType);
    switch (sniff.outcome) {
      case FileCheckOutcome.QUARANTINED:
        return {
          outcome: FileCheckOutcome.QUARANTINED,
          engineVersion: ApplicationFileCheck.ENGINE_VERSION,
          sanitizedResult: `detected=${sniff.detectedType}`,
          retryable: false,
        };
      case FileCheckOutcome.FAILED:
        return {
          outcome: FileCheckOutcome.FAILED,
          engineVersion: ApplicationFileCheck.ENGINE_VERSION,
          sanitizedResult: sniff.matchesDeclaration
            ? 'unknown-type'
            : `declared-mismatch detected=${sniff.detectedType}`,
          retryable: false,
        };
      default:
        return {
          outcome: FileCheckOutcome.PASSED,
          engineVersion: ApplicationFileCheck.ENGINE_VERSION,
          sanitizedResult: `detected=${sniff.detectedType}`,
          retryable: false,
        };
    }
  }
}
