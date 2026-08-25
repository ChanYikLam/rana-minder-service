/**
 * 文件域 HTTP 端点 Nest 适配控制器（interfaces/nest；IFC-FIL-001/003/005）。
 *
 * 路由（AuthGuard 未认证 401；每次访问实时重鉴权）：
 * - POST /api/files/upload              FormData 直传，无信封；返回 FileUploaded
 * - GET  /api/files/:fileId             返回 FileMetadata（status 为 'clean'|'approved'）
 * - POST /api/files/:fileId/download    返回 FileDownloadAuthorization（1h 短时地址）
 *
 * 约束（接口清单 §9 / files.contracts.ts）：
 * - 上传为 FormData 直传（无信封）；真实字节接收后进入检查，未检查完成不得开放访问；
 * - 所有文件访问端点每次重新鉴权：对象键、历史地址或旧短链均不能作为授权依据
 *   （IFC-DATA-009 / FORM-008）；
 * - 成功响应统一信封 { code: 0, data }；错误经 toApiError 脱敏输出。
 */

import {
  Body,
  Controller,
  HttpException,
  Inject,
  Param,
  Post,
  Get,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { ApiSuccess } from '../../../../common/contracts/api-envelope';
import type {
  FileDownloadAuthorization,
  FileMetadata,
  FileUploaded,
} from '../../../../common/contracts/files.contracts';
import { AuthGuard, sessionFromRequest } from '../../../identity/interfaces/nest/auth.guard';
import { FileState } from '../../domain/state-machines/file-state-machine';
import type { FileCategory, FileRecord } from '../../domain/models/file-model';
import { FileAccessAction } from '../../domain/services/access-policy';
import type { FileAccessRequest } from '../../domain/services/access-policy';
import { FileAccessDeniedError } from '../../domain/services/access-policy';
import { FILE_REPOSITORY } from '../../infrastructure/file-repository';
import type { FileRepository } from '../../infrastructure/file-repository';
import { InitiateUploadCommand } from '../../application/commands/initiate-upload.command';
import { CompleteUploadCommand } from '../../application/commands/complete-upload.command';
import { FileStatusQuery, FileStatusQueryError } from '../../application/queries/file-status.query';
import { FileAccessQuery } from '../../application/queries/file-access.query';
import { toApiError } from '../http/file-error-http';

/** POST /api/files/upload 的请求体（FormData 直传，无信封） */
export interface FileUploadBodyVo {
  /** 原始文件名（仅登记，不进入对象键；领域不持久化，见汇报“无法映射项”） */
  readonly name: string;
  /** 业务类别（PHOTO/VIDEO/GENERIC） */
  readonly category: FileCategory;
  /** 声明大小（字节） */
  readonly size: number;
  /** 声明 MIME 类型（不信任，仅登记） */
  readonly mimeType?: string;
  /** 真实字节（接收后进入隔离并检查；Buffer 为 Uint8Array 子类，可直传） */
  readonly bytes: Uint8Array;
  /** 创建作用域（社团/联合域/主体） */
  readonly scope?: { kind: string; clubId?: string; unionId?: string; subjectId?: string };
  /** 目标草稿/纠错对象与字段 */
  readonly target?: { objectType: string; objectId: string; fieldKey: string };
  /** 上传会话有效期（分钟；默认 30） */
  readonly sessionTtlMinutes?: number;
}

/** 下载授权短时地址有效期（1 小时，合约要求） */
const DOWNLOAD_TTL_MS = 60 * 60 * 1000;

@UseGuards(AuthGuard)
@Controller('api/files')
export class FileNestController {
  constructor(
    @Inject(InitiateUploadCommand) private readonly initiateUpload: InitiateUploadCommand,
    @Inject(CompleteUploadCommand) private readonly completeUpload: CompleteUploadCommand,
    @Inject(FileStatusQuery) private readonly fileStatus: FileStatusQuery,
    @Inject(FileAccessQuery) private readonly fileAccess: FileAccessQuery,
    @Inject(FILE_REPOSITORY) private readonly repo: FileRepository,
  ) {}

  /** 统一执行：领域错误经 toApiError 脱敏映射为 HttpException */
  private async run(op: () => Promise<unknown>): Promise<ApiSuccess<unknown>> {
    try {
      const value = await op();
      return { code: 0, data: value };
    } catch (error) {
      const mapped = toApiError(error);
      throw new HttpException(mapped.body, mapped.status);
    }
  }

  /** FormData 直传上传（IFC-FIL-001/002）：初始化 + 字节接收，进入检查中 */
  @Post('upload')
  async upload(
    @Req() request: Record<string, unknown>,
    @Body() body: FileUploadBodyVo,
  ): Promise<ApiSuccess<unknown>> {
    const s = sessionFromRequest(request);
    const subjectId = s.subjectId;
    return this.run(async () => {
      const initiated = await this.initiateUpload.execute({
        uploaderId: subjectId,
        scope: body.scope ?? { kind: 'SUBJECT', subjectId },
        category: body.category,
        declaredSizeBytes: body.size,
        declaredType: body.mimeType,
        target:
          body.target ?? { objectType: 'GENERIC', objectId: subjectId, fieldKey: 'generic' },
        sessionTtlMinutes: body.sessionTtlMinutes,
      });
      const completed = await this.completeUpload.execute({
        fileId: initiated.fileId,
        principalId: subjectId,
        sessionId: initiated.uploadSession!.sessionId,
        bytes: body.bytes,
      });
      return this.toUploaded(completed, body.name, s.now);
    });
  }

  /** 文件元数据查询（IFC-FIL-003）：仅上传者/有权角色可查；未检查通过不可访问 */
  @Get(':fileId')
  async getMetadata(
    @Req() request: Record<string, unknown>,
    @Param('fileId') fileId: string,
  ): Promise<ApiSuccess<unknown>> {
    const subjectId = sessionFromRequest(request).subjectId;
    return this.run(async () => {
      // 鉴权网关：应用层保证仅上传者或有权角色可见
      const view = await this.fileStatus.getStatus(fileId, subjectId);
      if (!view.accessible) {
        throw new FileAccessDeniedError('IFC-ERR-011', '文件尚未检查通过，暂不可访问');
      }
      const file = await this.repo.load(fileId);
      if (file === null) {
        throw new FileStatusQueryError('IFC-ERR-006: 文件不存在');
      }
      return this.toMetadata(file, view.state);
    });
  }

  /** 下载授权签发（IFC-FIL-005）：每次访问实时鉴权，签发 1 小时短时地址 */
  @Post(':fileId/download')
  async download(
    @Req() request: Record<string, unknown>,
    @Param('fileId') fileId: string,
  ): Promise<ApiSuccess<unknown>> {
    const s = sessionFromRequest(request);
    const subjectId = s.subjectId;
    return this.run(async () => {
      const file = await this.repo.load(fileId);
      if (file === null) {
        throw new FileStatusQueryError('IFC-ERR-006: 文件不存在');
      }
      const principalIsUploader = file.uploaderId === subjectId;
      const request2: FileAccessRequest = {
        fileId: file.fileId,
        fileState: file.state,
        category: file.category,
        uploaderId: file.uploaderId,
        target: file.target,
        fieldRestrictions: { previewable: true, downloadable: true },
        sensitive: false,
        ownerOnly: false,
        uploaderHistoryVisible: true,
      };
      const issued = await this.fileAccess.issueAccess({
        fileId,
        context: { principalId: subjectId, roles: [], businessState: 'OPEN' },
        request: request2,
        principalIsUploader,
        action: FileAccessAction.DOWNLOAD,
        safeForPreview: false,
        ttlMs: DOWNLOAD_TTL_MS,
      });
      return this.toDownloadAuthorization(fileId, issued.access.token, issued.access.expiresAt);
    });
  }

  /** FileRecord + 请求文件名 → FileUploaded 契约 */
  private toUploaded(file: FileRecord, name: string, now: Date): FileUploaded {
    const latest = file.versions[file.versions.length - 1];
    return {
      fileId: file.fileId,
      name,
      size: latest.declaredSize,
      mimeType: latest.declaredType,
      status: 'clean',
      uploadedAt: file.createdAt || now.toISOString(),
    };
  }

  /** FileRecord + 状态 → FileMetadata 契约（status 收敛为 'clean'|'approved'） */
  private toMetadata(file: FileRecord, state: FileState): FileMetadata {
    const latest = file.versions[file.versions.length - 1];
    const status: 'clean' | 'approved' =
      state === FileState.BOUND_TO_SUBMISSION ? 'approved' : 'clean';
    return {
      id: file.fileId,
      // 领域 FileRecord 不持久化文件名，这里无法映射（见汇报“无法映射项”）；
      // 退化为空串占位，真实实现应在上传时登记文件名到领域模型。
      name: '',
      size: latest.actualSize ?? latest.declaredSize,
      mimeType: latest.detectedType ?? latest.declaredType,
      status,
      uploadedAt: file.createdAt,
      checkedAt: file.checkRecord?.finishedAt ?? null,
      downloadUrl: null,
    };
  }

  /** 短时下载地址 → FileDownloadAuthorization 契约（expiresAt = now + 1h） */
  private toDownloadAuthorization(
    fileId: string,
    token: string,
    expiresAt: string,
  ): FileDownloadAuthorization {
    return {
      fileId,
      status: 'downloaded',
      downloadUrl: `/api/files/${fileId}/access?token=${token}`,
      expiresAt,
    };
  }
}
