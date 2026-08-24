import { Module } from '@nestjs/common';

import { AdaptersModule } from '../../adapters/adapters.module';
import { DB_ADAPTER } from '../../adapters/tokens';
import { SaveCorrectionDraftCommand } from './application/commands/correction-submit.command';
import { SubmitCorrectionCommand } from './application/commands/correction-submit.command';
import { DecideCorrectionCommand } from './application/commands/correction-decide.command';
import { WithdrawCorrectionCommand } from './application/commands/correction-decide.command';
import { MarkOverdueCommand } from './application/commands/correction-decide.command';
import { AuditWriter } from './application/commands/audit-writer';
import { CorrectionStatusQuery } from './application/queries/correction-status.query';
import { AuditQuery } from './application/queries/audit-query';
import { CorrectionStateMachine } from './domain/state-machines/correction-state-machine';
import { CorrectionPolicy } from './domain/services/correction-policy';
import { AuditSanitizer } from './domain/services/audit-sanitizer';
import { CORRECTION_REPOSITORY } from './infrastructure/correction-repository';
import { InMemoryCorrectionRepository } from './infrastructure/correction-repository';
import { AUDIT_REPOSITORY } from './infrastructure/audit-repository';
import { PostgresAuditRepository } from './infrastructure/postgres-audit-repository';
import { AuditUnitOfWork } from './infrastructure/audit-unit-of-work';
import { ArchiveActivityCommand } from './application/commands/archive-activity.command';
import { ArchiveAccessQuery } from './application/queries/archive-access.query';
import { ArchiveAccessPolicy } from './domain/services/archive-access-policy';
import { ARCHIVE_REPOSITORY } from './infrastructure/archive-repository';
import { InMemoryArchiveRepository } from './infrastructure/archive-repository';
import { FormalDeleteCommand } from './application/commands/formal-delete.command';
import {
  ExecuteDeletionChecklistCommand,
  DefaultDeletionStepExecutor,
  DELETION_STEP_EXECUTOR,
} from './application/commands/execute-deletion-checklist.command';
import { RetentionCleanupCommand } from './application/commands/retention-cleanup.command';
import {
  RETENTION_CLEANUP_EXECUTOR,
  DefaultRetentionCleanupExecutor,
} from './application/commands/retention-cleanup.command';
import { DeletionChecklistQuery } from './application/queries/deletion-checklist.query';
import { DeletionPolicy } from './domain/services/deletion-policy';
import { DELETION_CHECKLIST_REPOSITORY } from './infrastructure/deletion-checklist-repository';
import { PostgresDeletionChecklistRepository } from './infrastructure/postgres-deletion-checklist-repository';

/**
 * 领域模块：纠错、审计与数据生命周期（5.3，SRS-SM-AUD-001）。
 *
 * 职责：事实纠错（申请/批准/驳回/撤回/逾期）、不可变业务审计写入器、
 * 数据保留策略与正式删除执行清单。
 *
 * 核心不变量（AUD-001~010）：
 * - 纠错只追加：原值/原附件/原操作历史保留，终态不可覆盖；
 * - 客观错误才可纠错（单纯主观评价争议拒绝）；
 * - 作者回避：原作者不得单独批准自己的错误；
 * - 逾期只标记并提醒，不自动批准/驳回/修改业务记录；
 * - 审计不可改：关键审计与业务同事务（写入失败业务失败），敏感不落盘，
 *   应用内无修改/删除审计入口；删除只留最小审计；不建设匿名化。
 */
@Module({
  imports: [AdaptersModule],
  providers: [
    CorrectionStateMachine,
    CorrectionPolicy,
    AuditSanitizer,
    { provide: CORRECTION_REPOSITORY, useClass: InMemoryCorrectionRepository },
    {
      provide: AuditUnitOfWork,
      useFactory: (db) => new AuditUnitOfWork(db),
      inject: [DB_ADAPTER],
    },
    {
      provide: AUDIT_REPOSITORY,
      // 生产默认 PostgreSQL 落盘（审计持久化，重启不丢）；DB 未连接（NotWired 桩）
      // 时审计写入失败关闭，绝不让关键审计静默丢失。内存实现仅保留为开发/测试占位。
      useFactory: (db, uow) => new PostgresAuditRepository(db, uow),
      inject: [DB_ADAPTER, AuditUnitOfWork],
    },
    SaveCorrectionDraftCommand,
    SubmitCorrectionCommand,
    DecideCorrectionCommand,
    WithdrawCorrectionCommand,
    MarkOverdueCommand,
    CorrectionStatusQuery,
    AuditWriter,
    AuditQuery,
    ArchiveActivityCommand,
    ArchiveAccessQuery,
    ArchiveAccessPolicy,
    { provide: ARCHIVE_REPOSITORY, useClass: InMemoryArchiveRepository },
    DeletionPolicy,
    {
      provide: DELETION_CHECKLIST_REPOSITORY,
      // 生产默认 PostgreSQL 落盘（删除清单独立持久化，重启不丢、恢复重放有效；
      // W2 评审意见）；DB 未连接（NotWired 桩）时失败关闭。内存实现仅保留为测试占位。
      useFactory: (db) => new PostgresDeletionChecklistRepository(db),
      inject: [DB_ADAPTER],
    },
    {
      provide: DELETION_STEP_EXECUTOR,
      // 开发期占位（fail-closed：未接线即抛错，绝不静默假删除）；上线前须接入真实
      // 各存储删除执行器（在线库/附件/缓存/索引/未过期导出），接入后 deleteAndVerify
      // 执行删除并回读核验（AUD-009/IFC-TX-007）
      useClass: DefaultDeletionStepExecutor,
    },
    FormalDeleteCommand,
    ExecuteDeletionChecklistCommand,
    RetentionCleanupCommand,
    {
      provide: RETENTION_CLEANUP_EXECUTOR,
      // 开发期占位（fail-closed：未接线即抛错，绝不静默假清理）；生产接真实临时清理执行器（I2 评审意见）
      useClass: DefaultRetentionCleanupExecutor,
    },
    DeletionChecklistQuery,
  ],
  exports: [
    SaveCorrectionDraftCommand,
    SubmitCorrectionCommand,
    DecideCorrectionCommand,
    WithdrawCorrectionCommand,
    MarkOverdueCommand,
    CorrectionStatusQuery,
    AuditWriter,
    AuditQuery,
    ArchiveActivityCommand,
    ArchiveAccessQuery,
    FormalDeleteCommand,
    ExecuteDeletionChecklistCommand,
    RetentionCleanupCommand,
    DeletionChecklistQuery,
    CORRECTION_REPOSITORY,
    AUDIT_REPOSITORY,
    ARCHIVE_REPOSITORY,
    DELETION_CHECKLIST_REPOSITORY,
    DELETION_STEP_EXECUTOR,
    RETENTION_CLEANUP_EXECUTOR,
    AuditUnitOfWork,
  ],
})
export class AuditModule {}
