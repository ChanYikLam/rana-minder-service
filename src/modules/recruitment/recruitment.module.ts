/**
 * recruitment 模块 NestJS 装配（interfaces/nest + application + infrastructure）。
 *
 * 自包含分层装配：RecruitmentUnitOfWork（事务边界）→ PostgreSQL 仓储 →
 * 授权/表单端口（3.x 接入前 fail-closed 桩）→ 应用用例/查询 → 传输中立
 * RecruitmentController → Nest HTTP 适配控制器与守卫。
 *
 * 会话：Casdoor OIDC 会话链路接入前绑定 RejectAllRecruitmentAuthSessionProvider
 * （fail-closed，受保护端点 401）；授权：已接线组织授权（OrgBackedRecruitment-
 * Authorization，ORG-038 经 CURRENT_PERMISSIONS_PORT 逐请求重算；
 * canManage=club:recruitment:manage，canSubmit=非现任成员）。
 * 表单集成（4.4b 已收口）：RECRUITMENT_FORM_PORT 委托 form 模块提交仓储
 * （FormBackedRecruitmentForm），报名表走 4.1 真实表单提交链路。
 * 授权数据源（4.4 注记）：OrgBackedRecruitmentAuthorization 依赖 organization 的
 * CURRENT_PERMISSIONS_PORT——组织模块若仍为内存桩则授权随之失效；org 基础设施
 * 切换 PostgreSQL 时本适配器自动跟随变真，无需改动本模块。
 */

import { Module } from '@nestjs/common';

import { AdaptersModule } from '../../adapters/adapters.module';
import { ObservabilityModule } from '../../platform/observability/module';
import { OrganizationModule } from '../organization/module';
import { FormModule } from '../form/form.module';
import { IdentityModule } from '../identity/identity.module';
import { AUTH_SESSION_PROVIDER } from '../identity/tokens';
import { adaptSessionProvider } from '../../shared/adapt-session-provider';
import { CURRENT_PERMISSIONS_PORT } from '../organization/application/ports';
import { FORM_SUBMISSION_REPOSITORY } from '../form/tokens';
import { DB_ADAPTER } from '../../adapters/tokens';

import {
  RECRUITMENT_REPOSITORY,
  RECRUITMENT_AUTHORIZATION,
  RECRUITMENT_FORM_PORT,
  RECRUITMENT_AUTH_SESSION_PROVIDER,
  RECRUITMENT_CONTROLLER,
  CREATE_RECRUITMENT_ACTIVITY_USE_CASE,
  PUBLISH_RECRUITMENT_ACTIVITY_USE_CASE,
  PAUSE_RECRUITMENT_ACTIVITY_USE_CASE,
  RESUME_RECRUITMENT_ACTIVITY_USE_CASE,
  COMPLETE_RECRUITMENT_ACTIVITY_USE_CASE,
  CANCEL_RECRUITMENT_ACTIVITY_USE_CASE,
  FORCE_COMPLETE_RECRUITMENT_ACTIVITY_USE_CASE,
  PAUSE_APPLICATION_CHANNEL_USE_CASE,
  RESUME_APPLICATION_CHANNEL_USE_CASE,
  CLOSE_APPLICATION_CHANNEL_USE_CASE,
  REOPEN_APPLICATION_CHANNEL_USE_CASE,
  CREATE_REMEDY_WINDOW_USE_CASE,
  RECORD_TRANSFER_AUTHORIZATION_USE_CASE,
  PROMOTE_WAITLIST_TO_ADMIT_USE_CASE,
  PUBLISH_PATH_RESULT_USE_CASE,
  CHOOSE_INTERVIEW_SLOT_USE_CASE,
  RESCHEDULE_INTERVIEW_USE_CASE,
  OPEN_APPLICATION_CHANNEL_USE_CASE,
  SUBMIT_APPLICATION_USE_CASE,
  RECORD_DEPARTMENT_DECISION_USE_CASE,
  INTERVIEW_WORKFLOW_USE_CASE,
  SEND_ADMISSION_INVITATION_USE_CASE,
  ACCEPT_ADMISSION_INVITATION_USE_CASE,
  LIST_ACTIVITIES_QUERY,
  LIST_APPLICATIONS_QUERY,
  LIST_INTERVIEWS_QUERY,
} from './tokens';

import { RecruitmentUnitOfWork } from './infrastructure/unit-of-work';
import { PostgresRecruitmentRepository } from './infrastructure/postgres-recruitment.repository';
import { OrgBackedRecruitmentAuthorization } from './infrastructure/org-recruitment-authorization';
import { FormBackedRecruitmentForm } from './infrastructure/form-backed-recruitment-form';

import { DefaultCreateRecruitmentActivityUseCase } from './application/commands/create-recruitment-activity.use-case';
import { DefaultPublishRecruitmentActivityUseCase } from './application/commands/publish-recruitment-activity.use-case';
import {
  DefaultPauseRecruitmentActivityUseCase,
  DefaultResumeRecruitmentActivityUseCase,
  DefaultCompleteRecruitmentActivityUseCase,
  DefaultCancelRecruitmentActivityUseCase,
  DefaultForceCompleteRecruitmentActivityUseCase,
} from './application/commands/activity-lifecycle.use-case';
import {
  DefaultPauseApplicationChannelUseCase,
  DefaultResumeApplicationChannelUseCase,
  DefaultCloseApplicationChannelUseCase,
  DefaultReopenApplicationChannelUseCase,
} from './application/commands/channel-lifecycle.use-case';
import { DefaultCreateRemedyWindowUseCase } from './application/commands/remedy-window.use-case';
import {
  DefaultRecordTransferAuthorizationUseCase,
  DefaultPromoteWaitlistToAdmitUseCase,
  DefaultPublishPathResultUseCase,
} from './application/commands/path-result.use-case';
import {
  DefaultChooseInterviewSlotUseCase,
  DefaultRescheduleInterviewUseCase,
} from './application/commands/interview-slot.use-case';
import { DefaultOpenApplicationChannelUseCase } from './application/commands/open-application-channel.use-case';
import { DefaultSubmitApplicationUseCase } from './application/commands/submit-application.use-case';
import { DefaultRecordDepartmentDecisionUseCase } from './application/commands/record-department-decision.use-case';
import { InterviewWorkflowUseCase } from './application/commands/interview-workflow.use-case';
import {
  SendAdmissionInvitationUseCase,
  AcceptAdmissionInvitationUseCase,
} from './application/commands/admission.use-case';
import { DefaultListActivitiesQuery } from './application/queries/list-activities.query';
import { DefaultListApplicationsQuery } from './application/queries/list-applications.query';
import { DefaultListInterviewsQuery } from './application/queries/list-interviews.query';

import { RecruitmentController } from './interfaces/controllers/recruitment.controller';
import { RecruitmentAuthGuard } from './interfaces/nest/recruitment-auth.guard';
import { OrgRecruitmentNestController } from './interfaces/nest/org-recruitment.nest.controller';
import { ApplicantRecruitmentNestController } from './interfaces/nest/applicant-recruitment.nest.controller';

@Module({
  imports: [AdaptersModule, ObservabilityModule, OrganizationModule, IdentityModule, FormModule],
  controllers: [OrgRecruitmentNestController, ApplicantRecruitmentNestController],
  providers: [
    // ----- 会话（认证基建接入前失败关闭）-----
    {
      provide: RECRUITMENT_AUTH_SESSION_PROVIDER,
      useFactory: (identitySession) => adaptSessionProvider(identitySession),
      inject: [AUTH_SESSION_PROVIDER],
    },
    RecruitmentAuthGuard,
    // ----- 工作单元（事务边界）-----
    {
      provide: RecruitmentUnitOfWork,
      useFactory: (db) => new RecruitmentUnitOfWork(db),
      inject: [DB_ADAPTER],
    },
    // ----- PostgreSQL 仓储 -----
    {
      provide: RECRUITMENT_REPOSITORY,
      useFactory: (db, uow) => new PostgresRecruitmentRepository(db, uow),
      inject: [DB_ADAPTER, RecruitmentUnitOfWork],
    },
    // ----- 端口（授权已接线组织授权；表单集成已收口 FormBackedRecruitmentForm）-----
    {
      provide: RECRUITMENT_AUTHORIZATION,
      useFactory: (permissions) => new OrgBackedRecruitmentAuthorization(permissions),
      inject: [CURRENT_PERMISSIONS_PORT],
    },
    // ----- 4.4b 真集成收口：招新表单委托 form 模块提交仓储（报名表走真实表单链路）-----
    {
      provide: RECRUITMENT_FORM_PORT,
      useFactory: (submissions) => new FormBackedRecruitmentForm(submissions),
      inject: [FORM_SUBMISSION_REPOSITORY],
    },
    // ----- 应用命令 -----
    {
      provide: CREATE_RECRUITMENT_ACTIVITY_USE_CASE,
      useFactory: (repo, auth) => new DefaultCreateRecruitmentActivityUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: OPEN_APPLICATION_CHANNEL_USE_CASE,
      useFactory: (repo, auth) => new DefaultOpenApplicationChannelUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: PUBLISH_RECRUITMENT_ACTIVITY_USE_CASE,
      useFactory: (repo, auth) => new DefaultPublishRecruitmentActivityUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: PAUSE_RECRUITMENT_ACTIVITY_USE_CASE,
      useFactory: (repo, auth) => new DefaultPauseRecruitmentActivityUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: RESUME_RECRUITMENT_ACTIVITY_USE_CASE,
      useFactory: (repo, auth) => new DefaultResumeRecruitmentActivityUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: COMPLETE_RECRUITMENT_ACTIVITY_USE_CASE,
      useFactory: (repo, auth) => new DefaultCompleteRecruitmentActivityUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: CANCEL_RECRUITMENT_ACTIVITY_USE_CASE,
      useFactory: (repo, auth) => new DefaultCancelRecruitmentActivityUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: FORCE_COMPLETE_RECRUITMENT_ACTIVITY_USE_CASE,
      useFactory: (repo, auth) => new DefaultForceCompleteRecruitmentActivityUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: PAUSE_APPLICATION_CHANNEL_USE_CASE,
      useFactory: (repo, auth) => new DefaultPauseApplicationChannelUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: RESUME_APPLICATION_CHANNEL_USE_CASE,
      useFactory: (repo, auth) => new DefaultResumeApplicationChannelUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: CLOSE_APPLICATION_CHANNEL_USE_CASE,
      useFactory: (repo, auth) => new DefaultCloseApplicationChannelUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: REOPEN_APPLICATION_CHANNEL_USE_CASE,
      useFactory: (repo, auth) => new DefaultReopenApplicationChannelUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: CREATE_REMEDY_WINDOW_USE_CASE,
      useFactory: (repo, auth) => new DefaultCreateRemedyWindowUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: RECORD_TRANSFER_AUTHORIZATION_USE_CASE,
      useFactory: (repo, auth) => new DefaultRecordTransferAuthorizationUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: PROMOTE_WAITLIST_TO_ADMIT_USE_CASE,
      useFactory: (repo, auth) => new DefaultPromoteWaitlistToAdmitUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: PUBLISH_PATH_RESULT_USE_CASE,
      useFactory: (repo, auth) => new DefaultPublishPathResultUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: CHOOSE_INTERVIEW_SLOT_USE_CASE,
      useFactory: (repo, auth) => new DefaultChooseInterviewSlotUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: RESCHEDULE_INTERVIEW_USE_CASE,
      useFactory: (repo, auth) => new DefaultRescheduleInterviewUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: SUBMIT_APPLICATION_USE_CASE,
      useFactory: (repo, auth, form) => new DefaultSubmitApplicationUseCase(repo, auth, form),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION, RECRUITMENT_FORM_PORT],
    },
    {
      provide: RECORD_DEPARTMENT_DECISION_USE_CASE,
      useFactory: (repo, auth) => new DefaultRecordDepartmentDecisionUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    // ----- 应用查询 -----
    {
      provide: LIST_ACTIVITIES_QUERY,
      useFactory: (repo, auth) => new DefaultListActivitiesQuery(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: LIST_APPLICATIONS_QUERY,
      useFactory: (repo, auth) => new DefaultListApplicationsQuery(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: LIST_INTERVIEWS_QUERY,
      useFactory: (repo, auth) => new DefaultListInterviewsQuery(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: INTERVIEW_WORKFLOW_USE_CASE,
      useFactory: (repo, auth) => new InterviewWorkflowUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: SEND_ADMISSION_INVITATION_USE_CASE,
      useFactory: (repo, auth) => new SendAdmissionInvitationUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    {
      provide: ACCEPT_ADMISSION_INVITATION_USE_CASE,
      useFactory: (repo, auth) => new AcceptAdmissionInvitationUseCase(repo, auth),
      inject: [RECRUITMENT_REPOSITORY, RECRUITMENT_AUTHORIZATION],
    },
    // ----- 传输中立控制器 -----
    {
      provide: RECRUITMENT_CONTROLLER,
      useFactory: (
        uow,
        create,
        publish,
        open,
        submit,
        decide,
        interview,
        listA,
        listApp,
        listInt,
        send,
        accept,
      ) =>
        new RecruitmentController(
          uow,
          create,
          publish,
          open,
          submit,
          decide,
          interview,
          listA,
          listApp,
          listInt,
          send,
          accept,
        ),
      inject: [
        RecruitmentUnitOfWork,
        CREATE_RECRUITMENT_ACTIVITY_USE_CASE,
        PUBLISH_RECRUITMENT_ACTIVITY_USE_CASE,
        OPEN_APPLICATION_CHANNEL_USE_CASE,
        SUBMIT_APPLICATION_USE_CASE,
        RECORD_DEPARTMENT_DECISION_USE_CASE,
        INTERVIEW_WORKFLOW_USE_CASE,
        LIST_ACTIVITIES_QUERY,
        LIST_APPLICATIONS_QUERY,
        LIST_INTERVIEWS_QUERY,
        SEND_ADMISSION_INVITATION_USE_CASE,
        ACCEPT_ADMISSION_INVITATION_USE_CASE,
      ],
    },
  ],
  exports: [RecruitmentUnitOfWork, RECRUITMENT_AUTH_SESSION_PROVIDER, RecruitmentAuthGuard],
})
export class RecruitmentModule {}
