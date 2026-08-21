/**
 * identity 模块 NestJS 装配（interfaces/nest + application + infrastructure）。
 *
 * 分层装配：平台适配边界（AdaptersModule @Global 桩）→ IdentityUnitOfWork（ambient
 * 事务 + RLS）→ PostgreSQL 仓储/审计 → 领域适配器（Casdoor/邮件/任务/必填规则）→
 * 状态机与策略（纯规则单例）→ 应用用例/查询 → 传输中立控制器 → Nest HTTP 适配
 * 控制器与守卫。全部经 useFactory 冻结为 provider（领域/应用层不感知 Nest）。
 *
 * 会话：Casdoor OIDC 会话链路接入前绑定 RejectAllAuthSessionProvider（fail-closed，
 * 全部受保护端点 401 IFC-ERR-001）；接入后替换 AUTH_SESSION_PROVIDER 绑定即可。
 */

import { Module } from '@nestjs/common';

import { AdaptersModule } from '../../adapters/adapters.module';
import { ObservabilityModule } from '../../platform/observability/module';
import { APP_LOGGER } from '../../platform/observability/logging/tokens';
import { DB_ADAPTER, CASDOOR_ADAPTER, MAIL_CHANNEL_ADAPTER } from '../../adapters/tokens';

import {
  PROFILE_REPOSITORY,
  EMAIL_VERIFICATION_REPOSITORY,
  PROFILE_SYNC_INTENT_REPOSITORY,
  ACCOUNT_ACCESS_REPOSITORY,
  IDENTITY_AUDIT_PORT,
  CASDOOR_USER_PORT,
  MAIL_VERIFICATION_PORT,
  PROFILE_SYNC_TASK_PORT,
  REQUIRED_FIELD_RULES_PORT,
  NAME_CORRECTION_REPOSITORY,
  SUPER_ADMIN_VERIFIER,
  REAUTH_EVIDENCE_PORT,
  SESSION_REVOCATION_PORT,
  PROFILE_WRITE_GATE_MACHINE,
  PROFILE_SYNC_MACHINE,
  ACCOUNT_ACCESS_MACHINE,
  NAME_CORRECTION_MACHINE,
  PROFILE_GATE_POLICY,
  PROFILE_SYNC_POLICY,
  DEGRADATION_POLICY,
  SAVE_PROFILE_USE_CASE,
  EMAIL_VERIFICATION_USE_CASE,
  RESOLVE_SYNC_CONFLICT_USE_CASE,
  APPLY_PROFILE_SYNC_STEP_USE_CASE,
  HANDLE_ACCOUNT_STATUS_EVENT_USE_CASE,
  SUBMIT_NAME_CORRECTION_USE_CASE,
  REVIEW_NAME_CORRECTION_USE_CASE,
  APPLY_NAME_CORRECTION_WRITE_USE_CASE,
  GET_MY_PROFILE_QUERY,
  GET_ACCOUNT_ACCESS_QUERY,
  PROFILES_CONTROLLER,
  ACCOUNT_ACCESS_CONTROLLER,
  NAME_CORRECTION_CONTROLLER,
  AUTH_SESSION_PROVIDER,
} from './tokens';

import { IdentityUnitOfWork } from './infrastructure/unit-of-work';
import { PostgresProfileRepository } from './infrastructure/postgres-profile.repository';
import { PostgresEmailVerificationRepository } from './infrastructure/postgres-email-verification.repository';
import { PostgresProfileSyncIntentRepository } from './infrastructure/postgres-sync-intent.repository';
import { PostgresAccountAccessRepository } from './infrastructure/postgres-account-access.repository';
import { PostgresNameCorrectionRepository } from './infrastructure/postgres-name-correction.repository';
import { PostgresReauthEvidence } from './infrastructure/postgres-reauth-evidence';
import { PostgresSessionRevocation } from './infrastructure/postgres-session-revocation';
import { NotWiredSuperAdminVerifier } from './infrastructure/not-wired-super-admin.verifier';
import { PostgresIdentityAudit } from './infrastructure/postgres-audit';
import { CasdoorUserAdapter } from './infrastructure/casdoor-user.adapter';
import { MailVerificationChannel } from './infrastructure/mail-verification.channel';
import { ProfileSyncTaskWriter } from './infrastructure/profile-sync-task.writer';
import { StaticRequiredFieldRules } from './infrastructure/required-fields.rules';
import { AuthoritativeProfileField } from './domain/models/profile-field';

import { DefaultProfileWriteGateStateMachine } from './domain/state-machines/profile-write-gate.state-machine';
import { DefaultProfileSyncStateMachine } from './domain/state-machines/profile-sync.state-machine';
import { DefaultAccountAccessStateMachine } from './domain/state-machines/account-access.state-machine';
import { DefaultNameCorrectionStateMachine } from './domain/state-machines/name-correction.state-machine';
import { DefaultProfileGatePolicy } from './domain/services/profile-gate.policy';
import { DefaultProfileSyncPolicy } from './domain/services/profile-sync.policy';
import { DefaultDegradationPolicy } from './domain/services/degradation.policy';

import { DefaultSaveProfileUseCase } from './application/commands/save-profile.use-case';
import { DefaultEmailVerificationUseCase } from './application/commands/email-verification.use-case';
import { DefaultResolveSyncConflictUseCase } from './application/commands/resolve-sync-conflict.use-case';
import { DefaultApplyProfileSyncStepUseCase } from './application/commands/apply-profile-sync-step.use-case';
import { DefaultHandleAccountStatusEventUseCase } from './application/commands/handle-account-status-event.use-case';
import { DefaultSubmitNameCorrectionUseCase } from './application/commands/submit-name-correction.use-case';
import { DefaultReviewNameCorrectionUseCase } from './application/commands/review-name-correction.use-case';
import { DefaultApplyNameCorrectionWriteUseCase } from './application/commands/apply-name-correction-write.use-case';
import { HighRiskCommandGuard } from './application/services/high-risk-command.guard';
import { DefaultGetMyProfileQuery } from './application/queries/get-my-profile.query';
import { DefaultGetAccountAccessQuery } from './application/queries/get-account-access.query';

import { ProfilesController } from './interfaces/controllers/profiles.controller';
import { AccountAccessController } from './interfaces/controllers/account-access.controller';
import { NameCorrectionController } from './interfaces/controllers/name-correction.controller';

import { RejectAllAuthSessionProvider } from './interfaces/nest/auth-session';
import { AuthGuard } from './interfaces/nest/auth.guard';
import { ProfilesNestController } from './interfaces/nest/profiles.nest.controller';
import { AccountAccessNestController } from './interfaces/nest/account-access.nest.controller';
import { NameCorrectionNestController } from './interfaces/nest/name-correction.nest.controller';

@Module({
  imports: [AdaptersModule, ObservabilityModule],
  controllers: [ProfilesNestController, AccountAccessNestController, NameCorrectionNestController],
  providers: [
    // ----- 会话（认证基建接入前失败关闭）-----
    { provide: AUTH_SESSION_PROVIDER, useClass: RejectAllAuthSessionProvider },
    AuthGuard,
    // ----- 工作单元（ambient 事务 + RLS 单目标上下文）-----
    {
      provide: IdentityUnitOfWork,
      useFactory: (db, logger) => new IdentityUnitOfWork(db, logger),
      inject: [DB_ADAPTER, APP_LOGGER],
    },
    // ----- PostgreSQL 仓储与审计（事务外读写失败关闭）-----
    {
      provide: PROFILE_REPOSITORY,
      useFactory: (db, uow) => new PostgresProfileRepository(db, uow),
      inject: [DB_ADAPTER, IdentityUnitOfWork],
    },
    {
      provide: EMAIL_VERIFICATION_REPOSITORY,
      useFactory: (db, uow) => new PostgresEmailVerificationRepository(db, uow),
      inject: [DB_ADAPTER, IdentityUnitOfWork],
    },
    {
      provide: PROFILE_SYNC_INTENT_REPOSITORY,
      useFactory: (db, uow) => new PostgresProfileSyncIntentRepository(db, uow),
      inject: [DB_ADAPTER, IdentityUnitOfWork],
    },
    {
      provide: ACCOUNT_ACCESS_REPOSITORY,
      useFactory: (db, uow) => new PostgresAccountAccessRepository(db, uow),
      inject: [DB_ADAPTER, IdentityUnitOfWork],
    },
    {
      provide: NAME_CORRECTION_REPOSITORY,
      useFactory: (db, uow) => new PostgresNameCorrectionRepository(db, uow),
      inject: [DB_ADAPTER, IdentityUnitOfWork],
    },
    {
      provide: REAUTH_EVIDENCE_PORT,
      useFactory: (db, uow) => new PostgresReauthEvidence(db, uow),
      inject: [DB_ADAPTER, IdentityUnitOfWork],
    },
    {
      provide: SESSION_REVOCATION_PORT,
      useFactory: (db, uow) => new PostgresSessionRevocation(db, uow),
      inject: [DB_ADAPTER, IdentityUnitOfWork],
    },
    {
      provide: IDENTITY_AUDIT_PORT,
      useFactory: (db, uow) => new PostgresIdentityAudit(db, uow),
      inject: [DB_ADAPTER, IdentityUnitOfWork],
    },
    // ----- 领域适配器 -----
    {
      provide: CASDOOR_USER_PORT,
      useFactory: (casdoor) => new CasdoorUserAdapter(casdoor),
      inject: [CASDOOR_ADAPTER],
    },
    {
      provide: MAIL_VERIFICATION_PORT,
      useFactory: (mail, uow) => new MailVerificationChannel(mail, uow),
      inject: [MAIL_CHANNEL_ADAPTER, IdentityUnitOfWork],
    },
    {
      provide: PROFILE_SYNC_TASK_PORT,
      useFactory: (db, uow) => new ProfileSyncTaskWriter(db, uow),
      inject: [DB_ADAPTER, IdentityUnitOfWork],
    },
    { provide: REQUIRED_FIELD_RULES_PORT, useClass: StaticRequiredFieldRules },
    { provide: SUPER_ADMIN_VERIFIER, useClass: NotWiredSuperAdminVerifier },
    {
      provide: HighRiskCommandGuard,
      useFactory: (reauth) => new HighRiskCommandGuard(reauth),
      inject: [REAUTH_EVIDENCE_PORT],
    },
    // ----- 状态机与策略（纯规则单例）-----
    { provide: PROFILE_WRITE_GATE_MACHINE, useClass: DefaultProfileWriteGateStateMachine },
    { provide: PROFILE_SYNC_MACHINE, useClass: DefaultProfileSyncStateMachine },
    { provide: ACCOUNT_ACCESS_MACHINE, useClass: DefaultAccountAccessStateMachine },
    { provide: NAME_CORRECTION_MACHINE, useClass: DefaultNameCorrectionStateMachine },
    { provide: PROFILE_GATE_POLICY, useClass: DefaultProfileGatePolicy },
    { provide: PROFILE_SYNC_POLICY, useClass: DefaultProfileSyncPolicy },
    { provide: DEGRADATION_POLICY, useClass: DefaultDegradationPolicy },
    // ----- 应用命令与查询 -----
    {
      provide: SAVE_PROFILE_USE_CASE,
      useFactory: (profileRepo, intentRepo, required, taskPort, audit, gateMachine, gatePolicy) =>
        new DefaultSaveProfileUseCase(
          profileRepo,
          intentRepo,
          required,
          taskPort,
          audit,
          gateMachine,
          gatePolicy,
        ),
      inject: [
        PROFILE_REPOSITORY,
        PROFILE_SYNC_INTENT_REPOSITORY,
        REQUIRED_FIELD_RULES_PORT,
        PROFILE_SYNC_TASK_PORT,
        IDENTITY_AUDIT_PORT,
        PROFILE_WRITE_GATE_MACHINE,
        PROFILE_GATE_POLICY,
      ],
    },
    {
      provide: EMAIL_VERIFICATION_USE_CASE,
      useFactory: (
        profileRepo,
        verificationRepo,
        intentRepo,
        mailPort,
        taskPort,
        audit,
        gateMachine,
        gatePolicy,
      ) =>
        new DefaultEmailVerificationUseCase(
          profileRepo,
          verificationRepo,
          intentRepo,
          mailPort,
          taskPort,
          audit,
          gateMachine,
          gatePolicy,
        ),
      inject: [
        PROFILE_REPOSITORY,
        EMAIL_VERIFICATION_REPOSITORY,
        PROFILE_SYNC_INTENT_REPOSITORY,
        MAIL_VERIFICATION_PORT,
        PROFILE_SYNC_TASK_PORT,
        IDENTITY_AUDIT_PORT,
        PROFILE_WRITE_GATE_MACHINE,
        PROFILE_GATE_POLICY,
      ],
    },
    {
      provide: RESOLVE_SYNC_CONFLICT_USE_CASE,
      useFactory: (
        intentRepo,
        profileRepo,
        casdoor,
        taskPort,
        audit,
        machine,
        gateMachine,
        gatePolicy,
      ) =>
        new DefaultResolveSyncConflictUseCase(
          intentRepo,
          profileRepo,
          casdoor,
          taskPort,
          audit,
          machine,
          gateMachine,
          gatePolicy,
        ),
      inject: [
        PROFILE_SYNC_INTENT_REPOSITORY,
        PROFILE_REPOSITORY,
        CASDOOR_USER_PORT,
        PROFILE_SYNC_TASK_PORT,
        IDENTITY_AUDIT_PORT,
        PROFILE_SYNC_MACHINE,
        PROFILE_WRITE_GATE_MACHINE,
        PROFILE_GATE_POLICY,
      ],
    },
    {
      provide: APPLY_PROFILE_SYNC_STEP_USE_CASE,
      useFactory: (intentRepo, profileRepo, casdoor, taskPort, audit, machine, policy) =>
        new DefaultApplyProfileSyncStepUseCase(
          intentRepo,
          profileRepo,
          casdoor,
          taskPort,
          audit,
          machine,
          policy,
        ),
      inject: [
        PROFILE_SYNC_INTENT_REPOSITORY,
        PROFILE_REPOSITORY,
        CASDOOR_USER_PORT,
        PROFILE_SYNC_TASK_PORT,
        IDENTITY_AUDIT_PORT,
        PROFILE_SYNC_MACHINE,
        PROFILE_SYNC_POLICY,
      ],
    },
    {
      provide: HANDLE_ACCOUNT_STATUS_EVENT_USE_CASE,
      useFactory: (accountRepo, machine, audit, sessionRevocation) =>
        new DefaultHandleAccountStatusEventUseCase(accountRepo, machine, audit, sessionRevocation),
      inject: [
        ACCOUNT_ACCESS_REPOSITORY,
        ACCOUNT_ACCESS_MACHINE,
        IDENTITY_AUDIT_PORT,
        SESSION_REVOCATION_PORT,
      ],
    },
    {
      provide: SUBMIT_NAME_CORRECTION_USE_CASE,
      useFactory: (repo, audit) => new DefaultSubmitNameCorrectionUseCase(repo, audit),
      inject: [NAME_CORRECTION_REPOSITORY, IDENTITY_AUDIT_PORT],
    },
    {
      provide: REVIEW_NAME_CORRECTION_USE_CASE,
      useFactory: (repo, superAdmin, reauthGuard, taskPort, audit, machine) =>
        new DefaultReviewNameCorrectionUseCase(
          repo,
          superAdmin,
          reauthGuard,
          taskPort,
          audit,
          machine,
        ),
      inject: [
        NAME_CORRECTION_REPOSITORY,
        SUPER_ADMIN_VERIFIER,
        HighRiskCommandGuard,
        PROFILE_SYNC_TASK_PORT,
        IDENTITY_AUDIT_PORT,
        NAME_CORRECTION_MACHINE,
      ],
    },
    {
      provide: APPLY_NAME_CORRECTION_WRITE_USE_CASE,
      useFactory: (repo, casdoor, audit) =>
        new DefaultApplyNameCorrectionWriteUseCase(repo, casdoor, audit),
      inject: [NAME_CORRECTION_REPOSITORY, CASDOOR_USER_PORT, IDENTITY_AUDIT_PORT],
    },
    {
      provide: GET_MY_PROFILE_QUERY,
      useFactory: (profileRepo, intentRepo, accountRepo, degradation) =>
        new DefaultGetMyProfileQuery(profileRepo, intentRepo, accountRepo, degradation),
      inject: [
        PROFILE_REPOSITORY,
        PROFILE_SYNC_INTENT_REPOSITORY,
        ACCOUNT_ACCESS_REPOSITORY,
        DEGRADATION_POLICY,
      ],
    },
    {
      provide: GET_ACCOUNT_ACCESS_QUERY,
      useFactory: (accountRepo, degradation) =>
        new DefaultGetAccountAccessQuery(accountRepo, degradation),
      inject: [ACCOUNT_ACCESS_REPOSITORY, DEGRADATION_POLICY],
    },
    // ----- 传输中立控制器 -----
    {
      provide: PROFILES_CONTROLLER,
      useFactory: (saveProfile, emailVerification, resolveSyncConflict, getMyProfile, uow) =>
        new ProfilesController(
          saveProfile,
          emailVerification,
          resolveSyncConflict,
          getMyProfile,
          uow,
        ),
      inject: [
        SAVE_PROFILE_USE_CASE,
        EMAIL_VERIFICATION_USE_CASE,
        RESOLVE_SYNC_CONFLICT_USE_CASE,
        GET_MY_PROFILE_QUERY,
        IdentityUnitOfWork,
      ],
    },
    {
      provide: ACCOUNT_ACCESS_CONTROLLER,
      useFactory: (getMyProfile, getAccountAccess, uow) =>
        new AccountAccessController(getMyProfile, getAccountAccess, uow),
      inject: [GET_MY_PROFILE_QUERY, GET_ACCOUNT_ACCESS_QUERY, IdentityUnitOfWork],
    },
    {
      provide: NAME_CORRECTION_CONTROLLER,
      useFactory: (submit, review, casdoor, uow) =>
        new NameCorrectionController(
          submit,
          review,
          async (subjectId) => {
            // 旧姓名以可信观测为准（CAS-REC-001）；不可信/不可用时提交拒绝（fail-closed）
            const observation = await casdoor.readProfileField(
              subjectId,
              AuthoritativeProfileField.NAME,
            );
            return observation.status === 'SUCCESS' ? observation.data.value : null;
          },
          uow,
        ),
      inject: [
        SUBMIT_NAME_CORRECTION_USE_CASE,
        REVIEW_NAME_CORRECTION_USE_CASE,
        CASDOOR_USER_PORT,
        IdentityUnitOfWork,
      ],
    },
  ],
  exports: [
    IdentityUnitOfWork,
    APPLY_PROFILE_SYNC_STEP_USE_CASE,
    APPLY_NAME_CORRECTION_WRITE_USE_CASE,
    AUTH_SESSION_PROVIDER,
    AuthGuard,
  ],
})
export class IdentityModule {}
