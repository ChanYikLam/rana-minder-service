/**
 * identity 模块 NestJS 装配（interfaces/nest + application + infrastructure）。
 *
 * 分层装配：平台适配边界（AdaptersModule @Global 桩）→ IdentityUnitOfWork（ambient
 * 事务 + RLS）→ PostgreSQL 仓储/审计 → 领域适配器（Casdoor/邮件/任务/必填规则）→
 * 状态机与策略（纯规则单例）→ 应用用例/查询 → 传输中立控制器 → Nest HTTP 适配
 * 控制器与守卫。全部经 useFactory 冻结为 provider（领域/应用层不感知 Nest）。
 *
 * 会话：Casdoor OIDC 会话链路按 API-AUTH-001 条件装配——casdoor.endpoint 配置
 * 存在时绑定 OidcAuthSessionProvider（本地 JWT 验证），缺失时退回 RejectAllAuth
 * SessionProvider（fail-closed，受保护端点 401 IFC-ERR-001）。
 */

import { forwardRef, Module } from '@nestjs/common';

import { AdaptersModule } from '../../adapters/adapters.module';
import { ObservabilityModule } from '../../platform/observability/module';
import { APP_LOGGER } from '../../platform/observability/logging/tokens';
import { DB_ADAPTER, CASDOOR_ADAPTER, MAIL_CHANNEL_ADAPTER } from '../../adapters/tokens';
import type { CasdoorAdapter } from '../../adapters/casdoor/casdoor-adapter';

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
import {
  OidcAuthSessionProvider,
  type AccountStateObservation,
} from './interfaces/nest/oidc-session-provider';
import { CasdoorSessionController } from './interfaces/nest/casdoor-session.controller';
import { CasdoorAvailabilityTracker } from './interfaces/nest/casdoor-availability-tracker';
import {
  resolveCasdoorClientSecret,
  deriveSessionSecret,
} from './interfaces/nest/session-security';
import { RANA_MINDER_CONFIG, type RanaMinderConfig } from '../../config';
import { AuthGuard } from './interfaces/nest/auth.guard';
import { ProfilesNestController } from './interfaces/nest/profiles.nest.controller';
import { AccountAccessNestController } from './interfaces/nest/account-access.nest.controller';
import { NameCorrectionNestController } from './interfaces/nest/name-correction.nest.controller';

@Module({
  imports: [AdaptersModule, forwardRef(() => ObservabilityModule)],
  controllers: [
    ProfilesNestController,
    AccountAccessNestController,
    NameCorrectionNestController,
    CasdoorSessionController,
  ],
  providers: [
    // ----- Casdoor 运行时可用性跟踪（供 controller 观测 + provider 降级判定共享）-----
    CasdoorAvailabilityTracker,
    // ----- 会话（条件装配：Casdoor endpoint 配置时启用 OIDC；否则 fail-closed）-----
    {
      provide: AUTH_SESSION_PROVIDER,
      useFactory: (
        config: RanaMinderConfig,
        casdoor: CasdoorAdapter,
        tracker: CasdoorAvailabilityTracker,
      ) => {
        if (config.casdoor.endpoint && config.casdoor.clientId && config.casdoor.clientSecretRef) {
          // ADR-010：先解析引用为明文，再派生会话 HMAC 密钥（单点化，session-security.ts）。
          const clientSecret = resolveCasdoorClientSecret(config.casdoor.clientSecretRef);
          const sessionSecret = deriveSessionSecret(clientSecret);
          return new OidcAuthSessionProvider({
            sessionSecret,
            // CAS-REC-002 实时读回：每次请求复查账号状态（禁用/删除即时拒绝）。
            // 同时把读回观测写回 tracker（CAS-FAIL-001）：Casdoor 不可达时收紧降级窗口。
            checkAccountState: async (subjectId): Promise<AccountStateObservation> => {
              const user = await casdoor.getUser(subjectId);
              if (user.status !== 'SUCCESS' || user.data === null) {
                // 无法确定（未接线/不可达）→ 同步标记不可用，让降级窗口生效。
                tracker.setAvailable(false);
                return null;
              }
              // 读回成功 → Casdoor 可达，恢复可用观测。
              tracker.setAvailable(true);
              const state = user.data.state;
              if (state === 'ACTIVE' || state === 'DISABLED' || state === 'DELETED') {
                return state;
              }
              return null;
            },
            isCasdoorAvailable: () => tracker.isAvailable(),
          });
        }
        return new RejectAllAuthSessionProvider();
      },
      inject: [RANA_MINDER_CONFIG, CASDOOR_ADAPTER, CasdoorAvailabilityTracker],
    },
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
    SUPER_ADMIN_VERIFIER,
  ],
})
export class IdentityModule {}
