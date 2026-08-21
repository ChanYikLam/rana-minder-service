import { Module } from '@nestjs/common';
import { InitiateUploadCommand } from './application/commands/initiate-upload.command';
import { CompleteUploadCommand } from './application/commands/complete-upload.command';
import { AskFileCheckCommand } from './application/commands/ask-file-check.command';
import { PromoteFileCommand } from './application/commands/promote-file.command';
import { ReplaceDraftFileCommand } from './application/commands/replace-draft-file.command';
import { RemoveDraftFileCommand } from './application/commands/remove-draft-file.command';
import { CleanupOrphansCommand } from './application/commands/cleanup-orphans.command';
import { QueueFormalDeleteCommand } from './application/commands/queue-formal-delete.command';
import { DeleteManifestHandler } from './application/commands/delete-manifest.handler';
import { FileStatusQuery } from './application/queries/file-status.query';
import { FileAccessQuery } from './application/queries/file-access.query';
import { FileStateMachine } from './domain/state-machines/file-state-machine';
import { UploadPolicy } from './domain/services/upload-policy';
import { FileTypeGuard } from './domain/services/file-type-guard';
import { AccessPolicy } from './domain/services/access-policy';
import { WatermarkPolicy } from './domain/services/watermark-policy';
import { FILE_REPOSITORY } from './infrastructure/file-repository';
import { InMemoryFileRepository } from './infrastructure/in-memory-file-repository';
import { OBJECT_STORE_PORT } from './infrastructure/object-store-port';
import { InMemoryObjectStore } from './infrastructure/object-store-port';
import { FILE_CHECK_PORT } from './infrastructure/file-check-port';
import { ApplicationFileCheck } from './infrastructure/file-check-port';
import { SIGNED_URL_PROVIDER } from './infrastructure/signed-url-provider';
import { DefaultSignedUrlProvider } from './infrastructure/signed-url-provider';
import { ACCESS_AUDIT_PORT } from './infrastructure/access-audit-port';
import { LogOnlyAccessAudit } from './infrastructure/access-audit-port';
import { FORMAL_DELETE_CONFIRM_PORT } from './infrastructure/formal-delete-confirm-port';
import { LogOnlyFormalDeleteConfirm } from './infrastructure/formal-delete-confirm-port';
import { CLEANUP_REFERENCE_GUARD } from './infrastructure/cleanup-reference-guard-port';
import { LogOnlyCleanupReferenceGuard } from './infrastructure/cleanup-reference-guard-port';

/**
 * 领域模块：文件（4.2，SRS-SM-FILE-001）。
 *
 * 职责：上传初始化、字节接收、检查收口（晋升/隔离/不可用）、状态查询、
 * 访问授权（实时鉴权/短时地址/水印/审计）；
 * 字节在 S3 兼容对象存储（隔离区/权威原件区/临时派生区，ADR-008），
 * 元数据/检查/引用状态在 PostgreSQL（占位内存实现）。
 *
 * 核心不变量（FORM-007、GOV-008、FORM-008）：
 * - 未检查/检查中/失败/隔离的文件不可预览、下载或正式绑定；
 * - 检查服务不可用保持不可访问，不得超时自动放行；
 * - 每次附件访问实时鉴权，只生成短时最小范围地址并加必要水印；
 * - 数据库与对象存储不伪装原子事务，部分失败不得返回假成功。
 */
@Module({
  providers: [
    // 领域规则（纯规则）
    FileStateMachine,
    UploadPolicy,
    FileTypeGuard,
    AccessPolicy,
    WatermarkPolicy,
    // 基础设施端口（生产替换为 PostgreSQL/S3 适配实现）
    { provide: FILE_REPOSITORY, useClass: InMemoryFileRepository },
    { provide: OBJECT_STORE_PORT, useClass: InMemoryObjectStore },
    { provide: FILE_CHECK_PORT, useClass: ApplicationFileCheck },
    { provide: SIGNED_URL_PROVIDER, useClass: DefaultSignedUrlProvider },
    { provide: ACCESS_AUDIT_PORT, useClass: LogOnlyAccessAudit },
    { provide: FORMAL_DELETE_CONFIRM_PORT, useClass: LogOnlyFormalDeleteConfirm },
    { provide: CLEANUP_REFERENCE_GUARD, useClass: LogOnlyCleanupReferenceGuard },
    // 应用命令与查询
    InitiateUploadCommand,
    CompleteUploadCommand,
    AskFileCheckCommand,
    PromoteFileCommand,
    ReplaceDraftFileCommand,
    RemoveDraftFileCommand,
    CleanupOrphansCommand,
    QueueFormalDeleteCommand,
    DeleteManifestHandler,
    FileStatusQuery,
    FileAccessQuery,
  ],
  exports: [
    InitiateUploadCommand,
    CompleteUploadCommand,
    AskFileCheckCommand,
    PromoteFileCommand,
    ReplaceDraftFileCommand,
    RemoveDraftFileCommand,
    CleanupOrphansCommand,
    QueueFormalDeleteCommand,
    DeleteManifestHandler,
    FileStatusQuery,
    FileAccessQuery,
    FILE_REPOSITORY,
    OBJECT_STORE_PORT,
    FILE_CHECK_PORT,
    SIGNED_URL_PROVIDER,
    ACCESS_AUDIT_PORT,
    FORMAL_DELETE_CONFIRM_PORT,
    CLEANUP_REFERENCE_GUARD,
  ],
})
export class FileModule {}
