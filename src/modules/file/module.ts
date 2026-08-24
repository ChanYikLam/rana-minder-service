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
import { OBJECT_STORE_PORT } from './infrastructure/object-store-port';
import { InMemoryObjectStore } from './infrastructure/object-store-port';
import { PostgresFileRepository } from './infrastructure/postgres-file-repository';
import { FILE_CHECK_PORT } from './infrastructure/file-check-port';
import { ApplicationFileCheck } from './infrastructure/file-check-port';
import { SIGNED_URL_PROVIDER } from './infrastructure/signed-url-provider';
import { DefaultSignedUrlProvider } from './infrastructure/signed-url-provider';
import { ACCESS_AUDIT_PORT } from './infrastructure/access-audit-port';
import { PostgresAccessAudit } from './infrastructure/postgres-access-audit';
import { FORMAL_DELETE_CONFIRM_PORT } from './infrastructure/formal-delete-confirm-port';
import { PostgresFormalDeleteConfirm } from './infrastructure/postgres-formal-delete-confirm';
import { CLEANUP_REFERENCE_GUARD } from './infrastructure/cleanup-reference-guard-port';
import { PostgresCleanupReferenceGuard } from './infrastructure/postgres-cleanup-reference-guard';
import { AdaptersModule } from '../../adapters/adapters.module';
import { DB_ADAPTER } from '../../adapters/tokens';
import { S3ObjectStoreAdapter } from '../../adapters/storage/s3-object-store.adapter';
import { ExternalFileCheckAdapter } from '../../adapters/file-check/external-file-check.adapter';

/**
 * 领域模块：文件（4.2，SRS-SM-FILE-001）。
 *
 * 职责：上传初始化、字节接收、检查收口（晋升/隔离/不可用）、状态查询、
 * 访问授权（实时鉴权/短时地址/水印/审计）；
 * 字节在 S3 兼容对象存储（隔离区/权威原件区/临时派生区，ADR-008），
 * 元数据/检查/引用状态在 PostgreSQL（4.2 已收口；配置 S3_ENDPOINT 启用真实
 * 对象存储适配器，未配置保留开发占位；FILE_CHECK_ENDPOINT 启用外部检查服务）。
 *
 * 核心不变量（FORM-007、GOV-008、FORM-008）：
 * - 未检查/检查中/失败/隔离的文件不可预览、下载或正式绑定；
 * - 检查服务不可用保持不可访问，不得超时自动放行；
 * - 每次附件访问实时鉴权，只生成短时最小范围地址并加必要水印；
 * - 数据库与对象存储不伪装原子事务，部分失败不得返回假成功。
 */
@Module({
  imports: [AdaptersModule],
  providers: [
    // 领域规则（纯规则）
    FileStateMachine,
    UploadPolicy,
    FileTypeGuard,
    AccessPolicy,
    WatermarkPolicy,
    // 基础设施端口（生产替换为 PostgreSQL/S3 适配实现）
    // ----- 4.2 收口：PostgreSQL 元数据/审计/确认/引用复核（DB 未连接失败关闭）-----
    {
      provide: FILE_REPOSITORY,
      useFactory: (db) => new PostgresFileRepository(db),
      inject: [DB_ADAPTER],
    },
    {
      provide: ACCESS_AUDIT_PORT,
      useFactory: (db) => new PostgresAccessAudit(db),
      inject: [DB_ADAPTER],
    },
    {
      provide: FORMAL_DELETE_CONFIRM_PORT,
      useFactory: (db) => new PostgresFormalDeleteConfirm(db),
      inject: [DB_ADAPTER],
    },
    {
      provide: CLEANUP_REFERENCE_GUARD,
      useFactory: (db) => new PostgresCleanupReferenceGuard(db),
      inject: [DB_ADAPTER],
    },
    // ----- 4.2 收口：S3 兼容对象存储（配置 STORAGE_ENDPOINT 启用）-----
    {
      provide: OBJECT_STORE_PORT,
      useFactory: () => {
        // 评审修复（warning）：配置键名与 .env.example/config.example.yaml 文档对齐。
        // 文档键为 STORAGE_ENDPOINT/STORAGE_REGION/STORAGE_ACCESS_KEY/STORAGE_SECRET_KEY/
        // STORAGE_BUCKET_*；为兼容旧 S3_* 键保留别名回退（S3_* 优先，文档键次之）。
        // 注：BucketRole 的 OBJECT 角色对应文档"权威原件区" primary bucket（ADR-008 三区）。
        const endpoint = process.env.S3_ENDPOINT ?? process.env.STORAGE_ENDPOINT;
        if (endpoint !== undefined && endpoint.trim().length > 0) {
          return new S3ObjectStoreAdapter({
            endpoint,
            region: process.env.S3_REGION ?? process.env.STORAGE_REGION ?? 'cn-north-1',
            accessKeyId: process.env.S3_ACCESS_KEY_ID ?? process.env.STORAGE_ACCESS_KEY ?? '',
            secretAccessKey:
              process.env.S3_SECRET_ACCESS_KEY ?? process.env.STORAGE_SECRET_KEY ?? '',
            buckets: {
              QUARANTINE:
                process.env.S3_BUCKET_QUARANTINE ?? process.env.STORAGE_BUCKET_QUARANTINE ?? '',
              OBJECT: process.env.S3_BUCKET_OBJECT ?? process.env.STORAGE_BUCKET_PRIMARY ?? '',
              DERIVED: process.env.S3_BUCKET_DERIVED ?? process.env.STORAGE_BUCKET_DERIVED ?? '',
            },
          });
        }
        // 评审修复（部署风险）：**生产/非开发环境未配置 STORAGE_ENDPOINT 时 fail-closed**——
        // 静默降级内存对象存储会导致"元数据在 PostgreSQL、字节在内存（重启即失）"，
        // 且 InMemory deleteAndVerify 恒成功制造假删除（违反 FORM-009/NFR-003 不变量）；
        // 仅在 test/development 保留内存占位（单测/本地开发）。
        const env = process.env.NODE_ENV ?? 'development';
        if (env !== 'test' && env !== 'development') {
          throw new Error(
            'OBJECT_STORE_PORT: 生产环境必须配置 STORAGE_ENDPOINT/STORAGE_ACCESS_KEY/STORAGE_SECRET_KEY（fail-closed，禁止内存对象存储假持久化）',
          );
        }
        return new InMemoryObjectStore();
      },
    },
    // ----- 4.2 收口：外部文件检查服务（配置 FILE_CHECK_ENDPOINT 启用；未配置保留应用侧初检）-----
    {
      provide: FILE_CHECK_PORT,
      useFactory: () => {
        const endpoint = process.env.FILE_CHECK_ENDPOINT;
        if (endpoint !== undefined && endpoint.trim().length > 0) {
          return new ExternalFileCheckAdapter({
            endpoint,
            token: process.env.FILE_CHECK_TOKEN,
          });
        }
        return new ApplicationFileCheck();
      },
    },
    { provide: SIGNED_URL_PROVIDER, useClass: DefaultSignedUrlProvider },
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
