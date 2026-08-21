/**
 * recruitment 模块 NestJS 装配（interfaces/nest + application + infrastructure）。
 *
 * 自包含分层装配：RecruitmentUnitOfWork（事务边界）→ PostgreSQL 仓储 →
 * 授权/表单端口（3.x 接入前 fail-closed 桩）→ 应用用例/查询 → 传输中立
 * RecruitmentController → Nest HTTP 适配控制器与守卫。
 *
 * 会话：Casdoor OIDC 会话链路接入前绑定 RejectAllRecruitmentAuthSessionProvider
 * （fail-closed，受保护端点 401）；授权：3.x 组织/身份授权落地前绑定
 * NotWiredRecruitmentAuthorization（全部管理/提交操作拒绝）。
 */

import { Module } from '@nestjs/common';

import { AdaptersModule } from '../../adapters/adapters.module';
import { ObservabilityModule } from '../../platform/observability/module';
import { DB_ADAPTER } from '../../adapters/tokens';

import {
  RECRUITMENT_REPOSITORY,
  RECRUITMENT_AUTHORIZATION,
  RECRUITMENT_FORM_PORT,
  RECRUITMENT_AUTH_SESSION_PROVIDER,
  RECRUITMENT_CONTROLLER,
  CREATE_RECRUITMENT_ACTIVITY_USE_CASE,
  OPEN_APPLICATION_CHANNEL_USE_CASE,
  SUBMIT_APPLICATION_USE_CASE,
  RECORD_DEPARTMENT_DECISION_USE_CASE,
  LIST_ACTIVITIES_QUERY,
  LIST_APPLICATIONS_QUERY,
} from './tokens';

import { RecruitmentUnitOfWork } from './infrastructure/unit-of-work';
import { PostgresRecruitmentRepository } from './infrastructure/postgres-recruitment.repository';
import { NotWiredRecruitmentAuthorization } from './application/ports/recruitment-authorization.port';
import { StubRecruitmentForm } from './application/ports/recruitment-form.port';

import { DefaultCreateRecruitmentActivityUseCase } from './application/commands/create-recruitment-activity.use-case';
import { DefaultOpenApplicationChannelUseCase } from './application/commands/open-application-channel.use-case';
import { DefaultSubmitApplicationUseCase } from './application/commands/submit-application.use-case';
import { DefaultRecordDepartmentDecisionUseCase } from './application/commands/record-department-decision.use-case';
import { DefaultListActivitiesQuery } from './application/queries/list-activities.query';
import { DefaultListApplicationsQuery } from './application/queries/list-applications.query';

import { RecruitmentController } from './interfaces/controllers/recruitment.controller';
import { RejectAllRecruitmentAuthSessionProvider } from './interfaces/nest/recruitment-auth-session';
import { RecruitmentAuthGuard } from './interfaces/nest/recruitment-auth.guard';
import { OrgRecruitmentNestController } from './interfaces/nest/org-recruitment.nest.controller';

@Module({
  imports: [AdaptersModule, ObservabilityModule],
  controllers: [OrgRecruitmentNestController],
  providers: [
    // ----- 会话（认证基建接入前失败关闭）-----
    { provide: RECRUITMENT_AUTH_SESSION_PROVIDER, useClass: RejectAllRecruitmentAuthSessionProvider },
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
    // ----- 端口（3.x 接入前失败关闭桩）-----
    { provide: RECRUITMENT_AUTHORIZATION, useClass: NotWiredRecruitmentAuthorization },
    { provide: RECRUITMENT_FORM_PORT, useClass: StubRecruitmentForm },
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
      useFactory: (repo) => new DefaultListActivitiesQuery(repo),
      inject: [RECRUITMENT_REPOSITORY],
    },
    {
      provide: LIST_APPLICATIONS_QUERY,
      useFactory: (repo) => new DefaultListApplicationsQuery(repo),
      inject: [RECRUITMENT_REPOSITORY],
    },
    // ----- 传输中立控制器 -----
    {
      provide: RECRUITMENT_CONTROLLER,
      useFactory: (uow, create, open, submit, decide, listA, listApp) =>
        new RecruitmentController(uow, create, open, submit, decide, listA, listApp),
      inject: [
        RecruitmentUnitOfWork,
        CREATE_RECRUITMENT_ACTIVITY_USE_CASE,
        OPEN_APPLICATION_CHANNEL_USE_CASE,
        SUBMIT_APPLICATION_USE_CASE,
        RECORD_DEPARTMENT_DECISION_USE_CASE,
        LIST_ACTIVITIES_QUERY,
        LIST_APPLICATIONS_QUERY,
      ],
    },
  ],
  exports: [RecruitmentUnitOfWork, RECRUITMENT_AUTH_SESSION_PROVIDER, RecruitmentAuthGuard],
})
export class RecruitmentModule {}
