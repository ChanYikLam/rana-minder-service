import { Module } from '@nestjs/common';
import { SaveCorrectionDraftCommand } from './application/commands/correction-submit.command';
import { SubmitCorrectionCommand } from './application/commands/correction-submit.command';
import { DecideCorrectionCommand } from './application/commands/correction-decide.command';
import { WithdrawCorrectionCommand } from './application/commands/correction-decide.command';
import { MarkOverdueCommand } from './application/commands/correction-decide.command';
import { CorrectionStatusQuery } from './application/queries/correction-status.query';
import { CorrectionStateMachine } from './domain/state-machines/correction-state-machine';
import { CorrectionPolicy } from './domain/services/correction-policy';
import { CORRECTION_REPOSITORY } from './infrastructure/correction-repository';
import { InMemoryCorrectionRepository } from './infrastructure/correction-repository';

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
 * - 审计不可改、删除只留最小审计、不建设匿名化。
 */
@Module({
  providers: [
    CorrectionStateMachine,
    CorrectionPolicy,
    { provide: CORRECTION_REPOSITORY, useClass: InMemoryCorrectionRepository },
    SaveCorrectionDraftCommand,
    SubmitCorrectionCommand,
    DecideCorrectionCommand,
    WithdrawCorrectionCommand,
    MarkOverdueCommand,
    CorrectionStatusQuery,
  ],
  exports: [
    SaveCorrectionDraftCommand,
    SubmitCorrectionCommand,
    DecideCorrectionCommand,
    WithdrawCorrectionCommand,
    MarkOverdueCommand,
    CorrectionStatusQuery,
    CORRECTION_REPOSITORY,
  ],
})
export class AuditModule {}
